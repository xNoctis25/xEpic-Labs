import { Candle } from '../market/CandleAggregator';
import { BacktestResult, TradeRecord } from './types';
import { SMCExpert } from '../experts/SMCExpert';
import { MarketClock } from '../core/MarketClock';
import { PositionSizer, SizingResult } from '../core/PositionSizer';
import { config } from '../config/env';

/**
 * BacktestEngine — True Cash Account Backtester with Dynamic Scale-Out
 *
 * Uses PositionSizer for dynamic qty sizing and simulates the 3-tier
 * scale-out bracket logic from ExecutionEngine:
 *
 *   qty === 1 → The Pure Runner (trailing stop only)
 *   qty === 2 → The Split (TP1 at 1:1 + runner trailing)
 *   qty >= 3  → The Institutional (TP1 1:1 + TP2 1:2 + runner trailing)
 *
 * Each tier tracks partial P&L independently as exits are hit intrabar.
 */

// ─── Internal Tier Tracking ─────────────────────────────────────────

interface TierLeg {
    qty: number;
    tpPrice: number | null;   // null = no TP (runner)
    slPrice: number;          // Initial stop-loss
    trailingStop: boolean;    // Is this a trailing stop leg?
    trailPrice: number;       // Current trail price (updated per candle)
    filled: boolean;          // Has this leg been exited?
    pnl: number;              // Realized P&L for this leg
}

interface ActiveBacktestPosition {
    entryPrice: number;
    isLong: boolean;
    entryTime: number;
    totalQty: number;
    dollarPerPoint: number;   // $5 for MES, $50 for ES
    tiers: TierLeg[];
}

export class BacktestEngine {
    private initialCapital: number;

    constructor(initialCapital: number = 50000) {
        this.initialCapital = initialCapital;
    }

    /**
     * Determines the active ICT Silver Bullet window based on Eastern Time.
     * Uses MarketClock to guarantee correct ET regardless of host timezone.
     */
    private getTradingSession(timestamp: number): 'AM_KILLZONE' | 'CLOSED' {
        if (MarketClock.isAMKillzone(timestamp)) return 'AM_KILLZONE';
        return 'CLOSED';
    }

    /**
     * Builds the multi-tier leg structure based on qty (mirrors ExecutionEngine).
     */
    private buildTiers(
        entryPrice: number,
        isLong: boolean,
        qty: number,
        slPoints: number,
    ): TierLeg[] {
        const slPrice = isLong
            ? entryPrice - slPoints
            : entryPrice + slPoints;

        const tp1Price = isLong
            ? entryPrice + slPoints       // 1:1 RR
            : entryPrice - slPoints;

        const tp2Price = isLong
            ? entryPrice + (slPoints * 2)  // 1:2 RR
            : entryPrice - (slPoints * 2);

        // ── qty === 1: The Pure Runner ──
        if (qty === 1) {
            return [{
                qty: 1,
                tpPrice: null,
                slPrice,
                trailingStop: true,
                trailPrice: slPrice,
                filled: false,
                pnl: 0,
            }];
        }

        // ── qty === 2: The Split ──
        if (qty === 2) {
            return [
                {
                    qty: 1,
                    tpPrice: tp1Price,
                    slPrice,
                    trailingStop: false,
                    trailPrice: slPrice,
                    filled: false,
                    pnl: 0,
                },
                {
                    qty: 1,
                    tpPrice: null,
                    slPrice,
                    trailingStop: true,
                    trailPrice: slPrice,
                    filled: false,
                    pnl: 0,
                },
            ];
        }

        // ── qty >= 3: The Institutional 3-Tier ──
        const runnerQty = Math.floor(qty / 3);
        const tp1Qty = Math.ceil((qty - runnerQty) / 2);
        const tp2Qty = qty - runnerQty - tp1Qty;

        return [
            {
                qty: tp1Qty,
                tpPrice: tp1Price,
                slPrice,
                trailingStop: false,
                trailPrice: slPrice,
                filled: false,
                pnl: 0,
            },
            {
                qty: tp2Qty,
                tpPrice: tp2Price,
                slPrice,
                trailingStop: false,
                trailPrice: slPrice,
                filled: false,
                pnl: 0,
            },
            {
                qty: runnerQty,
                tpPrice: null,
                slPrice,
                trailingStop: true,
                trailPrice: slPrice,
                filled: false,
                pnl: 0,
            },
        ];
    }

    /**
     * Runs a standard backtest over a given set of candles.
     *
     * Uses SMCExpert (FVG + MSS) as the sole signal source.
     * PositionSizer determines dynamic qty per trade.
     * 3-tier scale-out simulates ExecutionEngine's bracket logic.
     *
     * Silver Bullet: Only opens trades during AM Killzone (09:30-11:00 ET).
     * Intrabar Slippage: Checks candle.high/low for TP/SL fills.
     * EOD Flatten: Open tiers run until TP/SL or forced exit at 15:55 ET.
     */
    public async runStandardBacktest(candles: Candle[], symbol: string): Promise<BacktestResult> {
        console.log(`[BacktestEngine] Running backtest on ${candles.length} candles for ${symbol}...`);
        console.log(`[BacktestEngine] Expert: SMCExpert (FVG + MSS) | Silver Bullet: AM Killzone 09:30-11:00 ET`);
        console.log(`[BacktestEngine] Scale-Out: Dynamic 3-Tier (PositionSizer + TrailingStop simulation)`);

        const smcExpert = new SMCExpert();

        const SL_POINTS = 20;
        const COOLDOWN_MS = 3 * 60 * 1000; // 3-minute cooldown after each trade

        let equity = this.initialCapital;
        let peakEquity = this.initialCapital;
        let maxDrawdown = 0;
        const trades: TradeRecord[] = [];

        let activePosition: ActiveBacktestPosition | null = null;
        let cooldownUntil = 0;

        for (let i = 0; i < candles.length; i++) {
            if (i > 0 && i % 10000 === 0) {
                console.log(`[BacktestEngine] Processed ${i} / ${candles.length} candles...`);
            }

            const candle = candles[i];
            const session = this.getTradingSession(candle.timestamp);

            // Trailing Max Drawdown Calculation
            if (equity > peakEquity) peakEquity = equity;
            const currentDrawdown = ((peakEquity - equity) / peakEquity) * 100;
            if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;

            // Feed every candle to the Expert (indicators must stay in sync)
            const signal = smcExpert.analyze(candle);

            // ==========================================
            // EXIT LOGIC — Multi-Tier Scale-Out Simulation
            // ==========================================
            if (activePosition) {
                const { entryPrice, isLong, tiers, dollarPerPoint } = activePosition;
                let allTiersFilled = true;

                for (const tier of tiers) {
                    if (tier.filled) continue;
                    allTiersFilled = false;

                    // ── Update Trailing Stop ──
                    if (tier.trailingStop) {
                        if (isLong) {
                            // Trail up: new trail = max(current trail, candle.high - SL_POINTS)
                            const newTrail = candle.high - SL_POINTS;
                            if (newTrail > tier.trailPrice) {
                                tier.trailPrice = newTrail;
                            }
                            tier.slPrice = tier.trailPrice;
                        } else {
                            // Trail down: new trail = min(current trail, candle.low + SL_POINTS)
                            const newTrail = candle.low + SL_POINTS;
                            if (newTrail < tier.trailPrice) {
                                tier.trailPrice = newTrail;
                            }
                            tier.slPrice = tier.trailPrice;
                        }
                    }

                    // ── Check TP hit ──
                    let hitTP = false;
                    if (tier.tpPrice !== null) {
                        hitTP = isLong
                            ? candle.high >= tier.tpPrice
                            : candle.low <= tier.tpPrice;
                    }

                    // ── Check SL hit ──
                    const hitSL = isLong
                        ? candle.low <= tier.slPrice
                        : candle.high >= tier.slPrice;

                    // ── Resolve exits ──
                    if (hitSL && hitTP) {
                        // Conservative: assume SL was hit first
                        const slPnl = isLong
                            ? (tier.slPrice - entryPrice) * dollarPerPoint * tier.qty
                            : (entryPrice - tier.slPrice) * dollarPerPoint * tier.qty;
                        tier.pnl = slPnl;
                        tier.filled = true;
                        equity += slPnl;
                    } else if (hitSL) {
                        const slPnl = isLong
                            ? (tier.slPrice - entryPrice) * dollarPerPoint * tier.qty
                            : (entryPrice - tier.slPrice) * dollarPerPoint * tier.qty;
                        tier.pnl = slPnl;
                        tier.filled = true;
                        equity += slPnl;
                    } else if (hitTP && tier.tpPrice !== null) {
                        const tpPnl = isLong
                            ? (tier.tpPrice - entryPrice) * dollarPerPoint * tier.qty
                            : (entryPrice - tier.tpPrice) * dollarPerPoint * tier.qty;
                        tier.pnl = tpPnl;
                        tier.filled = true;
                        equity += tpPnl;
                    }
                }

                // ── EOD Flatten at 15:55 ET — close all remaining tiers ──
                if (MarketClock.isEndOfDayFlatten(candle.timestamp)) {
                    for (const tier of tiers) {
                        if (tier.filled) continue;
                        const flatPnl = isLong
                            ? (candle.close - entryPrice) * dollarPerPoint * tier.qty
                            : (entryPrice - candle.close) * dollarPerPoint * tier.qty;
                        tier.pnl = flatPnl;
                        tier.filled = true;
                        equity += flatPnl;
                    }
                    allTiersFilled = true;
                }

                // ── All tiers closed — record the trade ──
                // Re-check after potential EOD flatten
                const allClosed = tiers.every(t => t.filled);
                if (allClosed) {
                    const totalPnl = tiers.reduce((sum, t) => sum + t.pnl, 0);
                    trades.push({
                        entryTime: activePosition.entryTime,
                        exitTime: candle.timestamp,
                        entryPrice: activePosition.entryPrice,
                        exitPrice: candle.close,
                        isLong: activePosition.isLong,
                        pnl: totalPnl,
                    });
                    activePosition = null;
                    cooldownUntil = candle.timestamp + COOLDOWN_MS;
                }
            }

            // ==========================================
            // ENTRY LOGIC — Silver Bullet + PositionSizer
            // ==========================================
            if (!activePosition && session === 'AM_KILLZONE' && candle.timestamp >= cooldownUntil) {
                if (signal === 'BUY' || signal === 'SELL') {
                    // Call PositionSizer with current equity
                    const sizing = PositionSizer.calculate(equity, SL_POINTS, config.INDICES);

                    if (!sizing) {
                        // Account cannot afford the trade
                        if (config.VERBOSE_SMC_LOGGING) {
                            console.log(`[Backtest] Trade Rejected: Insufficient Risk Budget. Equity: $${equity.toFixed(2)}`);
                        }
                        continue;
                    }

                    // Determine dollar-per-point based on sizer output
                    const dollarPerPoint = sizing.symbolRoot === 'ES' ? 50 : 5;

                    console.log(
                        `[Backtest] Sizing: $${equity.toFixed(2)} Capital` +
                        ` | Risk: ${config.RISK}%` +
                        ` | Budget: $${sizing.riskBudget.toFixed(2)}` +
                        ` | Buying ${sizing.qty} ${sizing.symbolRoot}`
                    );

                    const isLong = signal === 'BUY';
                    const tiers = this.buildTiers(candle.close, isLong, sizing.qty, SL_POINTS);

                    // Log tier allocation
                    const tierLabel = sizing.qty === 1
                        ? 'Pure Runner'
                        : sizing.qty === 2
                            ? 'The Split'
                            : `Institutional (TP1×${tiers[0].qty} + TP2×${tiers[1].qty} + Runner×${tiers[2].qty})`;
                    console.log(`[Backtest] ${signal} @ ${candle.close} | ${tierLabel}`);

                    activePosition = {
                        entryPrice: candle.close,
                        isLong,
                        entryTime: candle.timestamp,
                        totalQty: sizing.qty,
                        dollarPerPoint,
                        tiers,
                    };
                }
            }
        }

        // ── Force-close any position still open at end of data ──
        if (activePosition) {
            const lastCandle = candles[candles.length - 1];
            for (const tier of activePosition.tiers) {
                if (tier.filled) continue;
                const flatPnl = activePosition.isLong
                    ? (lastCandle.close - activePosition.entryPrice) * activePosition.dollarPerPoint * tier.qty
                    : (activePosition.entryPrice - lastCandle.close) * activePosition.dollarPerPoint * tier.qty;
                tier.pnl = flatPnl;
                tier.filled = true;
                equity += flatPnl;
            }
            const totalPnl = activePosition.tiers.reduce((sum, t) => sum + t.pnl, 0);
            trades.push({
                entryTime: activePosition.entryTime,
                exitTime: lastCandle.timestamp,
                entryPrice: activePosition.entryPrice,
                exitPrice: lastCandle.close,
                isLong: activePosition.isLong,
                pnl: totalPnl,
            });
            activePosition = null;
        }

        const winningTrades = trades.filter(t => t.pnl > 0).length;
        const losingTrades = trades.filter(t => t.pnl <= 0).length;
        const totalTrades = trades.length;
        const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

        console.log(`[BacktestEngine] Backtest complete. ${totalTrades} trades executed.`);

        return {
            totalTrades,
            winningTrades,
            losingTrades,
            winRate,
            netProfit: equity - this.initialCapital,
            maxDrawdown,
            startingEquity: this.initialCapital,
            endingEquity: equity,
            trades,
        };
    }

    /**
     * Walk-Forward Optimization (WFO) Orchestrator
     */
    public async runWalkForwardOptimization(symbol: string): Promise<void> {
        console.log(`[BacktestEngine] Initiating Walk-Forward Optimization for ${symbol}...`);
        console.log(`[BacktestEngine] WFO Architecture Ready. Waiting for expert injection.`);
    }
}
