/**
 * TradingCore.ts — Pure Trading Logic Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Contains ALL trading decision logic extracted from MoMEngine.
 * No IPC, no broker calls, no parentPort — pure candle/tick in, actions out.
 *
 * Used by:
 *   • MoMEngine (live) — thin IPC wrapper feeds ticks/candles, sends actions
 *   • BacktestEngine   — feeds historical candles, simulates fills
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { CandleAggregator, Candle, Tick } from '../market/CandleAggregator';
import { SMC, SmcSignal, FvgZone }        from '../experts/SMC';
import { MultiTimeframeAnalyzer }          from '../experts/MultiTimeframeAnalyzer';
import { MarketClock }                     from './MarketClock';
import { config }                          from '../config/env';

// ─────────────────────────────────────────────────────────────────────────────
// TRADE ACTION OUTPUT — what TradingCore tells its caller to do
// ─────────────────────────────────────────────────────────────────────────────
export interface TradeAction {
    type:        'ENTER' | 'EXIT' | 'MOVE_STOP' | 'TIGHTEN_STOP' | 'REJECTED' | 'LOG';
    direction?:  'LONG' | 'SHORT';
    price?:      number;
    stopPrice?:  number;
    riskR?:      number;
    reason:      string;
    confidence?: number;
    fvgZone?:    FvgZone;
    tradeId?:    string;
    /** For telemetry only — the gate or event name */
    gate?:       string;
    /** Killzone or Wilderness */
    regime?:     string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVE TRADE STATE
// ─────────────────────────────────────────────────────────────────────────────
export interface ActiveTradeContext {
    symbol:        string;
    direction:     'LONG' | 'SHORT';
    entryPrice:    number;
    stopPrice:     number;
    riskR:         number;  // 1R distance in points (structural stop distance)
    entryTs:       number;
    isWilderness:  boolean;
    beTriggered:   boolean;
    tradeId:       string;
    // ── ATM Monitoring State ──
    candlesSinceEntry: number;
    volumeHistory:     number[];
    candleHighHistory: number[];
    candleLowHistory:  number[];
    isChokeActive:     boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const SL_BUFFER_TICKS        = 2;          // buffer beyond FVG edge (2 ticks = 0.50 pts MES)
const SL_MAX_ATR_MULT        = 2.0;        // reject setup if structural stop exceeds 2.0× ATR
const SL_MAX_POINTS          = 8.0;        // hard cap — never more than 8pts regardless of ATR
const SL_MIN_DISTANCE        = 3.0;        // minimum stop distance in points (12 ticks MES)
const SL_WILDERNESS_PCT      = 0.50;       // cut SL by 50% in Wilderness
const MIN_SMC_PROBABILITY    = 65;         // minimum probability score (0-100%) to take a trade

// ── ATM Constants ───────────────────────────────────────────────────────────
const FLAT_TOLERANCE_POINTS  = 0.50;       // ≈ 2 ticks on MES
const VOLUME_DECLINE_COUNT   = 3;          // consecutive declining volume candles

// ─────────────────────────────────────────────────────────────────────────────
// TRADING CORE
// ─────────────────────────────────────────────────────────────────────────────
export class TradingCore {
    private smcExpert:   SMC;
    private mtfAnalyzer: MultiTimeframeAnalyzer;
    private aggregator:  CandleAggregator;

    private activeTrade: ActiveTradeContext | null = null;
    private tradeIdCounter = 0;
    private symbol: string;

    /** External gates — set by the caller (MoMEngine sets these via IPC) */
    public isDefconRed  = false;
    public isHuntingActive = false;

    /** Pending candle actions queued by the aggregator callback */
    private pendingActions: TradeAction[] = [];

    constructor(symbol: string) {
        this.symbol = symbol;
        this.smcExpert = new SMC();
        this.mtfAnalyzer = new MultiTimeframeAnalyzer();
        this.aggregator = new CandleAggregator(1, (candle) => this.onCandleComplete(candle));
    }

    // ─── PUBLIC API ─────────────────────────────────────────────────────────

    /** Feed a raw tick — aggregator builds candles, also checks real-time BE trigger. */
    public onTick(tick: Tick): TradeAction[] {
        this.pendingActions = [];
        this.aggregator.processTick(tick);

        // Real-time R-based Breakeven check (per-tick, not per-candle)
        if (this.activeTrade && !this.activeTrade.beTriggered) {
            const profit = this.activeTrade.direction === 'LONG'
                ? tick.price - this.activeTrade.entryPrice
                : this.activeTrade.entryPrice - tick.price;

            if (profit >= this.activeTrade.riskR) {
                this.activeTrade.beTriggered = true;
                this.activeTrade.stopPrice = this.activeTrade.entryPrice;
                this.pendingActions.push({
                    type: 'MOVE_STOP',
                    stopPrice: this.activeTrade.entryPrice,
                    tradeId: this.activeTrade.tradeId,
                    reason: `BE_TRIGGER @ 1R: trailing stop to breakeven @ ${this.activeTrade.entryPrice} (1R = ${this.activeTrade.riskR.toFixed(1)}pts)`,
                    direction: this.activeTrade.direction,
                });
            }
        }

        return this.pendingActions;
    }

    /**
     * Feed a completed candle directly (for backtest — bypasses aggregator).
     * Returns actions for the caller to execute.
     */
    public onCandle(candle: Candle): TradeAction[] {
        this.pendingActions = [];
        this.onCandleComplete(candle);
        return this.pendingActions;
    }

    /** Hydrate with historical candles — feeds indicators without generating signals. */
    public hydrate(candles: Candle[]): void {
        for (const c of candles) {
            this.mtfAnalyzer.analyze(c);
            this.smcExpert.analyze(c, true, this.mtfAnalyzer.isReady() ? this.mtfAnalyzer : undefined);
        }
    }

    /** Query state */
    public isInTrade(): boolean { return this.activeTrade !== null; }
    public getActiveTrade(): ActiveTradeContext | null { return this.activeTrade; }
    public getSmcExpert(): SMC { return this.smcExpert; }
    public getMtfAnalyzer(): MultiTimeframeAnalyzer { return this.mtfAnalyzer; }
    public getATR(): number { return this.smcExpert.getATR(); }

    /** Force-close trade state (called after external flatten confirmed). */
    public resetTradeState(): void {
        this.activeTrade = null;
    }

    /** Update the active contract symbol (e.g. after rollover). */
    public setSymbol(symbol: string): void { this.symbol = symbol; }

    /** Get last analyzed signal for external callers */
    public getLastSignal(): SmcSignal | null { return this._lastSignal; }
    private _lastSignal: SmcSignal | null = null;

    // ─── INTERNAL: CANDLE COMPLETE ──────────────────────────────────────────

    private onCandleComplete(candle: Candle): void {
        // ── EOD 16:30 Rolling Sweep ──
        if (MarketClock.isEndOfDayFlatten(candle.timestamp)) {
            if (this.activeTrade) {
                this.pendingActions.push({
                    type: 'EXIT',
                    tradeId: this.activeTrade.tradeId,
                    reason: 'EOD_FLATTEN_1630',
                    direction: this.activeTrade.direction,
                });
            }
            return;  // No new signals during EOD window
        }

        // Feed 1m candle to MTF analyzer
        this.mtfAnalyzer.analyze(candle);

        // Indicators-only when in trade or warmup
        const indicatorsOnly = !this.isHuntingActive || (this.activeTrade !== null);
        const signal = this.smcExpert.analyze(candle, indicatorsOnly, this.mtfAnalyzer.isReady() ? this.mtfAnalyzer : undefined);
        this._lastSignal = signal;

        // ── Active Trade Monitor (per-candle while in trade) ──
        if (this.activeTrade) {
            this.monitorActiveTrade(candle, signal);
            return;
        }

        // ── SMC Signal Pipeline (only when idle + hunting) ──
        this.evaluateSignal(candle, signal);
    }

    // ─── SIGNAL EVALUATION ──────────────────────────────────────────────────

    private evaluateSignal(candle: Candle, signal: SmcSignal): void {
        if (signal.action === 'HOLD') return;
        if (this.activeTrade) return;
        if (!this.isHuntingActive) return;

        const direction: 'LONG' | 'SHORT' = signal.action === 'BUY' ? 'LONG' : 'SHORT';
        const inWilderness = MarketClock.isWilderness(candle.timestamp);
        const regime = inWilderness ? 'Wilderness' : 'Killzone';

        // DEFCON RED gate
        if (this.isDefconRed) {
            this.pendingActions.push({
                type: 'REJECTED', gate: 'DEFCON', regime,
                direction, price: candle.close,
                confidence: signal.confidence,
                reason: `REJECTED by DEFCON | ${direction} ${this.symbol} @ ${candle.close} | Prob: ${signal.confidence}% | ${signal.reason}`,
            });
            return;
        }

        // Minimum probability gate
        if (signal.confidence < MIN_SMC_PROBABILITY) {
            this.pendingActions.push({
                type: 'REJECTED', gate: 'PROBABILITY_GATE', regime,
                direction, price: candle.close,
                confidence: signal.confidence,
                reason: `REJECTED by PROBABILITY_GATE | ${direction} ${this.symbol} @ ${candle.close} | Prob: ${signal.confidence}% (min: ${MIN_SMC_PROBABILITY}%) | ${signal.reason}`,
            });
            return;
        }

        // ── STRUCTURAL STOP LOSS ──
        const atr = this.smcExpert.getATR();
        const tickBuffer = SL_BUFFER_TICKS * 0.25;

        let stopPrice: number;
        if (signal.fvgZone) {
            stopPrice = direction === 'LONG'
                ? signal.fvgZone.bottom - tickBuffer
                : signal.fvgZone.top    + tickBuffer;
        } else {
            const fallbackDist = atr > 0 ? Math.max(3, Math.ceil(atr * 1.5)) : 10;
            stopPrice = direction === 'LONG'
                ? candle.close - fallbackDist
                : candle.close + fallbackDist;
        }

        let slDistance = Math.abs(candle.close - stopPrice);

        // Sanity floor: reject if structural stop is too tight (MES noise = 1-2pts)
        if (slDistance < SL_MIN_DISTANCE) {
            this.pendingActions.push({
                type: 'REJECTED', gate: 'SL_TOO_TIGHT', regime,
                direction, price: candle.close,
                confidence: signal.confidence,
                reason: `REJECTED by SL_TOO_TIGHT | ${direction} ${this.symbol} @ ${candle.close} | SL: ${slDistance.toFixed(1)}pts below ${SL_MIN_DISTANCE}pt minimum | ${signal.reason}`,
            });
            return;
        }

        // Sanity cap: reject if structural stop is too wide (ATR-relative)
        if (atr > 0 && slDistance > atr * SL_MAX_ATR_MULT) {
            this.pendingActions.push({
                type: 'REJECTED', gate: 'STRUCTURE_CAP', regime,
                direction, price: candle.close,
                confidence: signal.confidence,
                reason: `REJECTED by STRUCTURE_CAP | ${direction} ${this.symbol} @ ${candle.close} | SL: ${slDistance.toFixed(1)}pts exceeds ${SL_MAX_ATR_MULT}× ATR (${atr.toFixed(1)}) | ${signal.reason}`,
            });
            return;
        }

        // Hard cap: never allow a stop wider than SL_MAX_POINTS regardless of ATR
        if (slDistance > SL_MAX_POINTS) {
            this.pendingActions.push({
                type: 'REJECTED', gate: 'STRUCTURE_CAP', regime,
                direction, price: candle.close,
                confidence: signal.confidence,
                reason: `REJECTED by STRUCTURE_CAP | ${direction} ${this.symbol} @ ${candle.close} | SL: ${slDistance.toFixed(1)}pts exceeds hard cap (${SL_MAX_POINTS}pts) | ${signal.reason}`,
            });
            return;
        }

        if (inWilderness) {
            slDistance = Math.ceil(slDistance * SL_WILDERNESS_PCT);
            stopPrice = direction === 'LONG'
                ? candle.close - slDistance
                : candle.close + slDistance;
        }

        const riskR = slDistance;
        const tradeId = `${this.symbol}-${Date.now()}-${++this.tradeIdCounter}`;

        // ── ENTER request (caller handles Oracle handshake in live mode) ──
        this.pendingActions.push({
            type: 'ENTER',
            direction,
            price: candle.close,
            stopPrice,
            riskR,
            confidence: signal.confidence,
            fvgZone: signal.fvgZone,
            tradeId,
            regime,
            reason: `ENTER_SMC: ${this.symbol} ${direction} @ ${candle.close} | Prob: ${signal.confidence}% | ${signal.reason}`,
        });
    }

    /**
     * Called by the external caller AFTER Oracle handshake clears.
     * Commits the trade to active state.
     */
    public confirmEntry(action: TradeAction): void {
        this.activeTrade = {
            symbol:       this.symbol,
            direction:    action.direction!,
            entryPrice:   action.price!,
            stopPrice:    action.stopPrice!,
            riskR:        action.riskR!,
            entryTs:      Date.now(),
            isWilderness: action.regime === 'Wilderness',
            beTriggered:  false,
            tradeId:      action.tradeId!,
            candlesSinceEntry: 0,
            volumeHistory: [],
            candleHighHistory: [],
            candleLowHistory: [],
            isChokeActive: false,
        };
    }

    // ─── ACTIVE TRADE MONITOR ───────────────────────────────────────────────

    private monitorActiveTrade(candle: Candle, signal: SmcSignal): void {
        if (!this.activeTrade) return;

        const trade = this.activeTrade;
        trade.candlesSinceEntry++;
        trade.volumeHistory.push(candle.volume);
        trade.candleHighHistory.push(candle.high);
        trade.candleLowHistory.push(candle.low);

        const profitPoints = trade.direction === 'LONG'
            ? candle.close - trade.entryPrice
            : trade.entryPrice - candle.close;

        // ── System 2: Structural Invalidation ──
        if (signal.action !== 'HOLD') {
            const isOpposing = (trade.direction === 'LONG' && signal.action === 'SELL')
                            || (trade.direction === 'SHORT' && signal.action === 'BUY');
            if (isOpposing) {
                this.pendingActions.push({
                    type: 'EXIT',
                    tradeId: trade.tradeId,
                    direction: trade.direction,
                    reason: `STRUCTURAL_INVALIDATION: ${trade.direction} vs ${signal.action}. PnL: ${profitPoints.toFixed(1)}pts`,
                });
                return;
            }
        }

        // ── System 3a: Time Decay (env-gated) ──
        if (config.ENABLE_TIME_DECAY) {
            if (trade.candlesSinceEntry > config.TIME_DECAY_CANDLES && profitPoints <= FLAT_TOLERANCE_POINTS) {
                this.pendingActions.push({
                    type: 'EXIT',
                    tradeId: trade.tradeId,
                    direction: trade.direction,
                    reason: `TIME_DECAY: ${trade.candlesSinceEntry} candles, PnL: ${profitPoints.toFixed(2)}pts — momentum dead.`,
                });
                return;
            }
        }

        // ── System 3b: Momentum Exhaustion (env-gated) ──
        if (config.ENABLE_EXHAUSTION) {
            const decliningVol = this.checkVolumeDecline(trade);
            const priceStalled = this.checkPriceStalled(trade);

            if (decliningVol && priceStalled) {
                if (profitPoints <= 0) {
                    this.pendingActions.push({
                        type: 'EXIT',
                        tradeId: trade.tradeId,
                        direction: trade.direction,
                        reason: `EXHAUSTION_NEGATIVE_PNL: declining volume + price stalled. PnL: ${profitPoints.toFixed(1)}pts`,
                    });
                    return;
                }

                // ── System 4: Choke Hold ──
                this.engageChokeHold(trade, candle.close, profitPoints);
            }
        }
    }

    // ─── HELPERS ────────────────────────────────────────────────────────────

    private checkVolumeDecline(trade: ActiveTradeContext): boolean {
        const h = trade.volumeHistory;
        if (h.length < VOLUME_DECLINE_COUNT) return false;
        for (let i = h.length - VOLUME_DECLINE_COUNT + 1; i < h.length; i++) {
            if (h[i] >= h[i - 1]) return false;
        }
        return true;
    }

    private checkPriceStalled(trade: ActiveTradeContext): boolean {
        if (trade.candleHighHistory.length < 3) return false;
        const len = trade.candleHighHistory.length;

        if (trade.direction === 'LONG') {
            const curHigh = trade.candleHighHistory[len - 1];
            const priorHigh = Math.max(trade.candleHighHistory[len - 2], trade.candleHighHistory[len - 3]);
            return curHigh <= priorHigh;
        } else {
            const curLow = trade.candleLowHistory[len - 1];
            const priorLow = Math.min(trade.candleLowHistory[len - 2], trade.candleLowHistory[len - 3]);
            return curLow >= priorLow;
        }
    }

    private engageChokeHold(trade: ActiveTradeContext, currentPrice: number, profitPoints: number): void {
        const chokeDistance = Math.max(1, trade.riskR * 0.5);
        let tightStop = trade.direction === 'LONG'
            ? currentPrice - chokeDistance
            : currentPrice + chokeDistance;

        const locksProfit = trade.direction === 'LONG'
            ? tightStop > trade.entryPrice
            : tightStop < trade.entryPrice;

        if (!locksProfit) {
            tightStop = trade.direction === 'LONG'
                ? trade.entryPrice + 0.25
                : trade.entryPrice - 0.25;
        }

        const label = trade.isChokeActive ? 'TIGHTENED' : 'ENGAGED';
        trade.isChokeActive = true;

        this.pendingActions.push({
            type: 'TIGHTEN_STOP',
            stopPrice: tightStop,
            tradeId: trade.tradeId,
            direction: trade.direction,
            reason: `CHOKE_HOLD_${label}: stop → $${tightStop} (0.5R=${chokeDistance.toFixed(1)}pts behind @ $${currentPrice}). Profit: ${profitPoints.toFixed(1)}pts`,
        });
    }

    /**
     * Handle IMMINENT_REVERSION warning — tighten stop to 0.5R behind current price.
     */
    public handleImminentReversion(currentPrice: number): TradeAction | null {
        if (!this.activeTrade) return null;
        const chokeR = Math.max(1, this.activeTrade.riskR * 0.5);
        const tightStop = this.activeTrade.direction === 'LONG'
            ? currentPrice - chokeR
            : currentPrice + chokeR;
        return {
            type: 'TIGHTEN_STOP',
            stopPrice: tightStop,
            direction: this.activeTrade.direction,
            tradeId: this.activeTrade.tradeId,
            reason: `IMMINENT_REVERSION: stop → $${tightStop} (0.5R=${chokeR.toFixed(1)}pts behind)`,
        };
    }
}
