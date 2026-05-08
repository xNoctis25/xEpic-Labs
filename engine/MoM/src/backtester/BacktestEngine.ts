import { Candle } from '../market/CandleAggregator';
import { BacktestResult, TradeRecord } from './types';
import { TradingCore, TradeAction, ActiveTradeContext } from '../core/TradingCore';
import { PositionSizer } from '../core/PositionSizer';
import { MarketClock } from '../core/MarketClock';
import { config } from '../config/env';

/**
 * BacktestEngine — Fill Simulator Using TradingCore
 *
 * Uses the EXACT SAME TradingCore class as the live MoMEngine.
 * This engine only handles:
 *   1. Feeding candles to TradingCore
 *   2. Simulating bracket fills (TP/SL) against candle OHLC
 *   3. Position sizing via PositionSizer
 *   4. Equity tracking and trade recording
 *
 * ALL trading logic (signals, stops, BE, choke, exhaustion) lives in TradingCore.
 */

// ─── Fill Simulation State ──────────────────────────────────────────────────

interface BracketLeg {
    qty: number;
    tpPrice: number | null;
    slPrice: number;
    trailingStop: boolean;
    trailDistance: number;
    trailPrice: number;
    filled: boolean;
    pnl: number;
}

interface SimulatedPosition {
    entryPrice: number;
    isLong: boolean;
    entryTime: number;
    totalQty: number;
    dollarPerPoint: number;
    riskR: number;
    confidence: number;
    entryReason: string;
    tradeId: string;
    legs: BracketLeg[];
    beTriggered: boolean;  // candle-based breakeven (mirrors live onTick BE)
}

export class BacktestEngine {
    private initialCapital: number;

    constructor(initialCapital: number = 50000) {
        this.initialCapital = initialCapital;
    }

    /**
     * Build scale-out legs mirroring ExecutionEngine's 3-tier bracket logic.
     * Uses the structural stop (riskR) for R-based TP targets.
     */
    private buildLegs(
        entryPrice: number,
        isLong: boolean,
        qty: number,
        riskR: number,
        stopPrice: number,
    ): BracketLeg[] {
        const tp1Price = isLong
            ? entryPrice + (riskR * 1.0)   // 1:1 R — books partial quickly
            : entryPrice - (riskR * 1.0);

        const tp2Price = isLong
            ? entryPrice + (riskR * 2.0)  // 1:2 R — institutional runner target
            : entryPrice - (riskR * 2.0);

        // qty === 1: Pure Runner — holds until structural EXIT or SL
        if (qty === 1) {
            return [{
                qty: 1, tpPrice: null, slPrice: stopPrice,
                trailingStop: false, trailDistance: riskR, trailPrice: stopPrice,
                filled: false, pnl: 0,
            }];
        }

        // qty === 2: The Split
        if (qty === 2) {
            return [
                {
                    qty: 1, tpPrice: tp1Price, slPrice: stopPrice,
                    trailingStop: false, trailDistance: riskR, trailPrice: stopPrice,
                    filled: false, pnl: 0,
                },
                {
                    // Runner — no trailing stop, holds on structural logic
                    qty: 1, tpPrice: null, slPrice: stopPrice,
                    trailingStop: false, trailDistance: riskR, trailPrice: stopPrice,
                    filled: false, pnl: 0,
                },
            ];
        }

        // qty >= 3: Institutional 3-Tier
        const runnerQty = Math.floor(qty / 3);
        const tp1Qty = Math.ceil((qty - runnerQty) / 2);
        const tp2Qty = qty - runnerQty - tp1Qty;

        return [
            {
                qty: tp1Qty, tpPrice: tp1Price, slPrice: stopPrice,
                trailingStop: false, trailDistance: riskR, trailPrice: stopPrice,
                filled: false, pnl: 0,
            },
            {
                qty: tp2Qty, tpPrice: tp2Price, slPrice: stopPrice,
                trailingStop: false, trailDistance: riskR, trailPrice: stopPrice,
                filled: false, pnl: 0,
            },
            {
                // Runner — no arithmetic trail, exits on TradingCore EXIT or EOD
                qty: runnerQty, tpPrice: null, slPrice: stopPrice,
                trailingStop: false, trailDistance: riskR, trailPrice: stopPrice,
                filled: false, pnl: 0,
            },
        ];
    }

    /**
     * Runs backtest using TradingCore — the exact same logic as live.
     */
    public async runStandardBacktest(candles: Candle[], symbol: string): Promise<BacktestResult> {
        console.log(`[BacktestEngine] Running backtest on ${candles.length} candles for ${symbol}...`);
        console.log(`[BacktestEngine] Expert: TradingCore (SMC + structural stops + R-based management)`);
        console.log(`[BacktestEngine] Scale-Out: Dynamic 3-Tier (PositionSizer + R-based trailing)`);

        const core = new TradingCore(symbol);
        core.isHuntingActive = true;  // Backtest starts immediately — no warmup needed

        const COOLDOWN_MS = 3 * 60 * 1000;

        let equity = this.initialCapital;
        let peakEquity = this.initialCapital;
        let maxDrawdown = 0;
        let maxDrawdownDollars = 0;
        const trades: TradeRecord[] = [];

        let position: SimulatedPosition | null = null;
        let cooldownUntil = 0;
        let pendingEntry: TradeAction | null = null;

        for (let i = 0; i < candles.length; i++) {
            if (i > 0 && i % 10000 === 0) {
                console.log(`[BacktestEngine] Processed ${i} / ${candles.length} candles...`);
            }

            const candle = candles[i];

            // Trailing Max Drawdown
            if (equity > peakEquity) peakEquity = equity;
            const currentDrawdown = ((peakEquity - equity) / peakEquity) * 100;
            const currentDrawdownDollars = peakEquity - equity;
            if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
            if (currentDrawdownDollars > maxDrawdownDollars) maxDrawdownDollars = currentDrawdownDollars;

            // ── SIMULATE FILLS on existing position (before TradingCore sees the candle) ──
            if (position) {
                const { entryPrice, isLong, legs, dollarPerPoint } = position;

                for (const leg of legs) {
                    if (leg.filled) continue;

                    // Update trailing stop
                    if (leg.trailingStop) {
                        if (isLong) {
                            const newTrail = candle.high - leg.trailDistance;
                            if (newTrail > leg.trailPrice) leg.trailPrice = newTrail;
                            leg.slPrice = leg.trailPrice;
                        } else {
                            const newTrail = candle.low + leg.trailDistance;
                            if (newTrail < leg.trailPrice) leg.trailPrice = newTrail;
                            leg.slPrice = leg.trailPrice;
                        }
                    }

                    // Check TP hit
                    let hitTP = false;
                    if (leg.tpPrice !== null) {
                        hitTP = isLong
                            ? candle.high >= leg.tpPrice
                            : candle.low <= leg.tpPrice;
                    }

                    // Check SL hit
                    const hitSL = isLong
                        ? candle.low <= leg.slPrice
                        : candle.high >= leg.slPrice;

                    // Resolve exits (conservative: SL wins on ambiguous candles)
                    if (hitSL && hitTP) {
                        const slPnl = isLong
                            ? (leg.slPrice - entryPrice) * dollarPerPoint * leg.qty
                            : (entryPrice - leg.slPrice) * dollarPerPoint * leg.qty;
                        leg.pnl = slPnl;
                        leg.filled = true;
                        equity += slPnl;
                    } else if (hitSL) {
                        const slPnl = isLong
                            ? (leg.slPrice - entryPrice) * dollarPerPoint * leg.qty
                            : (entryPrice - leg.slPrice) * dollarPerPoint * leg.qty;
                        leg.pnl = slPnl;
                        leg.filled = true;
                        equity += slPnl;
                    } else if (hitTP && leg.tpPrice !== null) {
                        const tpPnl = isLong
                            ? (leg.tpPrice - entryPrice) * dollarPerPoint * leg.qty
                            : (entryPrice - leg.tpPrice) * dollarPerPoint * leg.qty;
                        leg.pnl = tpPnl;
                        leg.filled = true;
                        equity += tpPnl;
                    }
                }

                // ── Deferred Candle-Based Breakeven ──────────────────────────
                // When TP1 fills (+1R), lock TP2 stop at entry (protected).
                // Runner has NO stop move — it holds its structural SL until
                // TradingCore fires EXIT or EOD flatten closes it.
                if (!position.beTriggered) {
                    const reachedBE = isLong
                        ? candle.high >= entryPrice + (position.riskR * 1.0)
                        : candle.low  <= entryPrice - (position.riskR * 1.0);

                    if (reachedBE) {
                        position.beTriggered = true;
                        for (const leg of legs) {
                            if (leg.filled) continue;
                            // Only move the fixed-TP legs to BE — runner keeps structural SL
                            if (leg.tpPrice !== null) {
                                if (isLong && entryPrice > leg.slPrice)  leg.slPrice = entryPrice;
                                else if (!isLong && entryPrice < leg.slPrice) leg.slPrice = entryPrice;
                            }
                        }
                    }
                }

                // EOD flatten remaining legs
                if (MarketClock.isEndOfDayFlatten(candle.timestamp)) {
                    for (const leg of legs) {
                        if (leg.filled) continue;
                        const flatPnl = isLong
                            ? (candle.close - entryPrice) * dollarPerPoint * leg.qty
                            : (entryPrice - candle.close) * dollarPerPoint * leg.qty;
                        leg.pnl = flatPnl;
                        leg.filled = true;
                        equity += flatPnl;
                    }
                }

                // All legs closed → record trade
                if (legs.every(l => l.filled)) {
                    const totalPnl = legs.reduce((sum, l) => sum + l.pnl, 0);
                    const rMultiple = position.riskR > 0
                        ? totalPnl / (position.riskR * dollarPerPoint * position.totalQty)
                        : 0;

                    trades.push({
                        entryTime: position.entryTime,
                        exitTime: candle.timestamp,
                        entryPrice: position.entryPrice,
                        exitPrice: candle.close,
                        isLong: position.isLong,
                        pnl: totalPnl,
                        riskR: position.riskR,
                        rMultiple,
                        confidence: position.confidence,
                        entryReason: position.entryReason,
                        exitReason: 'BRACKET_FILL',
                    });

                    core.resetTradeState();
                    position = null;
                    cooldownUntil = candle.timestamp + COOLDOWN_MS;
                }
            }

            // ── FEED CANDLE TO TRADING CORE ──
            const actions = core.onCandle(candle);

            for (const action of actions) {
                switch (action.type) {
                    case 'ENTER': {
                        // Respect cooldown
                        if (position || candle.timestamp < cooldownUntil) break;

                        // Position sizing
                        const sizing = PositionSizer.calculate(equity, action.riskR!, config.INDICES);
                        if (!sizing) break;

                        const dollarPerPoint = sizing.symbolRoot === 'ES' ? 50 : 5;

                        // Confirm entry in TradingCore
                        core.confirmEntry(action);

                        // Build bracket legs
                        const isLong = action.direction === 'LONG';
                        const legs = this.buildLegs(
                            action.price!, isLong, sizing.qty,
                            action.riskR!, action.stopPrice!,
                        );

                        position = {
                            entryPrice: action.price!,
                            isLong,
                            entryTime: candle.timestamp,
                            totalQty: sizing.qty,
                            dollarPerPoint,
                            riskR: action.riskR!,
                            confidence: action.confidence ?? 0,
                            entryReason: action.reason,
                            tradeId: action.tradeId!,
                            legs,
                            beTriggered: false,
                        };

                        console.log(
                            `[Backtest] ${action.direction} @ ${action.price} | ` +
                            `SL: ${action.stopPrice!.toFixed(2)} (${action.riskR!.toFixed(1)}R) | ` +
                            `Prob: ${action.confidence}% | ${sizing.qty}x ${sizing.symbolRoot}`
                        );
                        break;
                    }

                    case 'EXIT': {
                        if (!position) break;
                        // Force-close all remaining legs at candle close
                        for (const leg of position.legs) {
                            if (leg.filled) continue;
                            const flatPnl = position.isLong
                                ? (candle.close - position.entryPrice) * position.dollarPerPoint * leg.qty
                                : (position.entryPrice - candle.close) * position.dollarPerPoint * leg.qty;
                            leg.pnl = flatPnl;
                            leg.filled = true;
                            equity += flatPnl;
                        }

                        const totalPnl = position.legs.reduce((sum, l) => sum + l.pnl, 0);
                        const rMultiple = position.riskR > 0
                            ? totalPnl / (position.riskR * position.dollarPerPoint * position.totalQty)
                            : 0;

                        trades.push({
                            entryTime: position.entryTime,
                            exitTime: candle.timestamp,
                            entryPrice: position.entryPrice,
                            exitPrice: candle.close,
                            isLong: position.isLong,
                            pnl: totalPnl,
                            riskR: position.riskR,
                            rMultiple,
                            confidence: position.confidence,
                            entryReason: position.entryReason,
                            exitReason: action.reason,
                        });

                        core.resetTradeState();
                        position = null;
                        cooldownUntil = candle.timestamp + COOLDOWN_MS;
                        break;
                    }

                    case 'MOVE_STOP':
                    case 'TIGHTEN_STOP': {
                        if (!position) break;
                        // Update all non-filled leg stops
                        for (const leg of position.legs) {
                            if (leg.filled) continue;
                            if (action.stopPrice! > leg.slPrice && position.isLong) {
                                leg.slPrice = action.stopPrice!;
                                if (leg.trailingStop) leg.trailPrice = action.stopPrice!;
                            } else if (action.stopPrice! < leg.slPrice && !position.isLong) {
                                leg.slPrice = action.stopPrice!;
                                if (leg.trailingStop) leg.trailPrice = action.stopPrice!;
                            }
                        }
                        break;
                    }

                    case 'REJECTED':
                        // Logged but no action needed in backtest
                        break;
                }
            }
        }

        // ── Force-close any position still open at end of data ──
        if (position) {
            const lastCandle = candles[candles.length - 1];
            for (const leg of position.legs) {
                if (leg.filled) continue;
                const flatPnl = position.isLong
                    ? (lastCandle.close - position.entryPrice) * position.dollarPerPoint * leg.qty
                    : (position.entryPrice - lastCandle.close) * position.dollarPerPoint * leg.qty;
                leg.pnl = flatPnl;
                leg.filled = true;
                equity += flatPnl;
            }
            const totalPnl = position.legs.reduce((sum, l) => sum + l.pnl, 0);
            const rMultiple = position.riskR > 0
                ? totalPnl / (position.riskR * position.dollarPerPoint * position.totalQty)
                : 0;
            trades.push({
                entryTime: position.entryTime,
                exitTime: lastCandle.timestamp,
                entryPrice: position.entryPrice,
                exitPrice: lastCandle.close,
                isLong: position.isLong,
                pnl: totalPnl,
                riskR: position.riskR,
                rMultiple,
                confidence: position.confidence,
                entryReason: position.entryReason,
                exitReason: 'END_OF_DATA',
            });
        }

        // ── Stats ──
        const winningTrades = trades.filter(t => t.pnl > 0).length;
        const losingTrades = trades.filter(t => t.pnl <= 0).length;
        const totalTrades = trades.length;
        const winRate = totalTrades > 0 ? (winningTrades / totalTrades) * 100 : 0;

        const avgWin = winningTrades > 0
            ? trades.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0) / winningTrades
            : 0;
        const avgLoss = losingTrades > 0
            ? Math.abs(trades.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0)) / losingTrades
            : 0;
        const avgRMult = totalTrades > 0
            ? trades.reduce((s, t) => s + t.rMultiple, 0) / totalTrades
            : 0;

        console.log(`\n[BacktestEngine] ═══════════════════════════════════════`);
        console.log(`[BacktestEngine]  Backtest Complete — ${totalTrades} trades`);
        console.log(`[BacktestEngine] ═══════════════════════════════════════`);
        console.log(`[BacktestEngine]  Win Rate:     ${winRate.toFixed(1)}% (${winningTrades}W / ${losingTrades}L)`);
        console.log(`[BacktestEngine]  Net Profit:   $${(equity - this.initialCapital).toFixed(2)}`);
        console.log(`[BacktestEngine]  Max Drawdown: ${maxDrawdown.toFixed(2)}% ($${maxDrawdownDollars.toFixed(2)} | ${maxDrawdownDollars / 50} ES pts | ${maxDrawdownDollars / 5} MES pts)`);
        console.log(`[BacktestEngine]  Avg Win:      $${avgWin.toFixed(2)}`);
        console.log(`[BacktestEngine]  Avg Loss:     $${avgLoss.toFixed(2)}`);
        console.log(`[BacktestEngine]  Avg R-Mult:   ${avgRMult.toFixed(2)}R`);
        console.log(`[BacktestEngine]  Equity:       $${this.initialCapital.toFixed(0)} → $${equity.toFixed(2)}`);
        console.log(`[BacktestEngine] ═══════════════════════════════════════\n`);

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
}
