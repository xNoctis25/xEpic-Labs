import { Candle } from '../market/CandleAggregator';
import { BacktestResult, TradeRecord } from './types';
import { SMCExpert } from '../experts/SMCExpert';
import { MarketClock } from '../core/MarketClock';

export class BacktestEngine {
    private initialCapital: number;

    constructor(initialCapital: number = 1000) {
        // Starting with $1,000 capital for Micros (MES/MNQ)
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
     * Runs a standard backtest over a given set of candles.
     * Uses SMCExpert (Fair Value Gap + MSS) as the sole signal source.
     *
     * Silver Bullet: Only opens trades during AM Killzone (09:30-11:00 ET).
     * Intrabar Slippage: Checks candle.high/low for TP/SL fills instead of candle.close.
     * EOD Flatten: Open trades run until TP/SL or forced exit at 15:55 ET.
     */
    public async runStandardBacktest(candles: Candle[], symbol: string): Promise<BacktestResult> {
        console.log(`[BacktestEngine] Running backtest on ${candles.length} candles for ${symbol}...`);
        console.log(`[BacktestEngine] Expert loaded: SMCExpert (FVG + MSS)`);
        console.log(`[BacktestEngine] Silver Bullet: AM Killzone 09:30-11:00 ET only`);

        // Instantiate fresh Expert for each backtest run (it accumulates internal state)
        const smcExpert = new SMCExpert();

        let equity = this.initialCapital;
        let peakEquity = this.initialCapital;
        let maxDrawdown = 0;
        const trades: TradeRecord[] = [];

        // Fixed TP/SL parameters (in points) — 2:1 Intraday Trend (MES = $5/pt)
        const TP_POINTS = 40;   // 40 points = $200 on MES ($5/pt)
        const SL_POINTS = 20;   // 20 points = $100 on MES ($5/pt)
        const DOLLAR_PER_POINT = 5;
        const COOLDOWN_MS = 3 * 60 * 1000;  // 3-minute cooldown after each trade

        let activePosition: { entryPrice: number; isLong: boolean; entryTime: number } | null = null;
        let cooldownUntil = 0;

        for (let i = 0; i < candles.length; i++) {
            // Print a progress update every 10,000 candles
            if (i > 0 && i % 10000 === 0) {
                console.log(`[BacktestEngine] Processed ${i} / ${candles.length} candles...`);
            }
            const candle = candles[i];
            const session = this.getTradingSession(candle.timestamp);

            // Trailing Max Drawdown Calculation
            if (equity > peakEquity) peakEquity = equity;
            const currentDrawdown = ((peakEquity - equity) / peakEquity) * 100;
            if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;

            // Feed every candle to the Expert so its internal indicators stay in sync
            // (even during CLOSED session — indicators must see all data)
            const signal = smcExpert.analyze(candle);

            if (activePosition) {
                // --- Exit Logic: Intrabar High/Low Slippage ---
                const { entryPrice, isLong } = activePosition;

                let exitTriggered = false;
                let exitPrice = 0;
                let exitPnL = 0;

                if (isLong) {
                    const targetPrice = entryPrice + TP_POINTS;
                    let stopPrice = entryPrice - SL_POINTS;

                    // Break-Even: if price reached +20 pts, move SL to entry
                    if (candle.high >= entryPrice + 20) {
                        stopPrice = Math.max(stopPrice, entryPrice);
                    }

                    const hitSL = candle.low <= stopPrice;
                    const hitTP = candle.high >= targetPrice;

                    if (hitSL && hitTP) {
                        // Conservative Rule: assume SL was hit first
                        exitPrice = stopPrice;
                        exitPnL = (stopPrice - entryPrice) * DOLLAR_PER_POINT;
                        exitTriggered = true;
                    } else if (hitSL) {
                        exitPrice = stopPrice;
                        exitPnL = (stopPrice - entryPrice) * DOLLAR_PER_POINT;
                        exitTriggered = true;
                    } else if (hitTP) {
                        exitPrice = targetPrice;
                        exitPnL = TP_POINTS * DOLLAR_PER_POINT;
                        exitTriggered = true;
                    }
                } else {
                    // SHORT position
                    const targetPrice = entryPrice - TP_POINTS;
                    let stopPrice = entryPrice + SL_POINTS;

                    // Break-Even: if price reached +20 pts, move SL to entry
                    if (candle.low <= entryPrice - 20) {
                        stopPrice = Math.min(stopPrice, entryPrice);
                    }

                    const hitSL = candle.high >= stopPrice;
                    const hitTP = candle.low <= targetPrice;

                    if (hitSL && hitTP) {
                        // Conservative Rule: assume SL was hit first
                        exitPrice = stopPrice;
                        exitPnL = (entryPrice - stopPrice) * DOLLAR_PER_POINT;
                        exitTriggered = true;
                    } else if (hitSL) {
                        exitPrice = stopPrice;
                        exitPnL = (entryPrice - stopPrice) * DOLLAR_PER_POINT;
                        exitTriggered = true;
                    } else if (hitTP) {
                        exitPrice = targetPrice;
                        exitPnL = TP_POINTS * DOLLAR_PER_POINT;
                        exitTriggered = true;
                    }
                }

                // True EOD Flatten at 15:55 ET — uses MarketClock for host-agnostic ET
                if (!exitTriggered && MarketClock.isEndOfDayFlatten(candle.timestamp)) {
                    const flatPnl = isLong
                        ? (candle.close - entryPrice)
                        : (entryPrice - candle.close);
                    exitPrice = candle.close;
                    exitPnL = flatPnl * DOLLAR_PER_POINT;
                    exitTriggered = true;
                }

                if (exitTriggered) {
                    equity += exitPnL;
                    trades.push({
                        entryTime: activePosition.entryTime,
                        exitTime: candle.timestamp,
                        entryPrice: activePosition.entryPrice,
                        exitPrice,
                        isLong: activePosition.isLong,
                        pnl: exitPnL,
                    });
                    activePosition = null;

                    // Cooldown: prevent revenge trading for 15 minutes after any exit
                    cooldownUntil = candle.timestamp + COOLDOWN_MS;
                }
            }

            // --- Entry Logic: Silver Bullet AM Killzone + Cooldown Gate ---
            // Only accept Expert signals during AM Killzone AND after cooldown expires
            if (!activePosition && session === 'AM_KILLZONE' && candle.timestamp >= cooldownUntil) {
                if (signal === 'BUY') {
                    activePosition = { entryPrice: candle.close, isLong: true, entryTime: candle.timestamp };
                } else if (signal === 'SELL') {
                    activePosition = { entryPrice: candle.close, isLong: false, entryTime: candle.timestamp };
                }
            }
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
            trades
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
