/**
 * MultiTimeframeAnalyzer.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Institutional top-down analysis for scalping:
 *   • 1H  → Directional Bias  (which direction to trade)
 *   • 15M → Structure          (where the setup is)
 *   • 5M  → Confirmation       (is momentum with us)
 *   • 1M  → Entry trigger      (handled by SMC, not here)
 *
 * Builds higher-TF candles from 1m data. Runs 3-bar pivot swing structure
 * detection on each TF. Provides an alignment snapshot used by the
 * probability model.
 *
 * Key principle: re-analysis fires ONLY when a TF candle closes.
 * Between closes, the last bias holds. No noise.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { Candle } from '../market/CandleAggregator';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type TFTrend = 'Bullish' | 'Bearish' | 'Neutral';

export interface TFBias {
    trend:     TFTrend;
    swingHigh: number | null;
    swingLow:  number | null;
    lastClose: number;
    candleCount: number;        // how many completed candles in this TF
}

export interface MTFSnapshot {
    tf1h:           TFBias;
    tf15m:          TFBias;
    tf5m:           TFBias;
    alignmentScore: number;     // 0-3: how many TFs agree on direction
    dominantBias:   TFTrend;
    isReady:        boolean;    // all TFs have minimum candles
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const PIVOT_BARS   = 3;     // 3-bar pivot for swing detection (same as SMC)

// Minimum completed candles per TF before bias is considered valid
const MIN_1H_CANDLES  = 5;
const MIN_15M_CANDLES = 8;
const MIN_5M_CANDLES  = 10;

// Ring buffer sizes
const MAX_1H_CANDLES  = 30;
const MAX_15M_CANDLES = 80;
const MAX_5M_CANDLES  = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Per-Timeframe State
// ─────────────────────────────────────────────────────────────────────────────

interface TFState {
    intervalMs:      number;            // candle interval in ms
    candles:         Candle[];           // completed candles ring buffer
    maxCandles:      number;            // ring buffer cap
    minCandles:      number;            // min before considered valid
    currentCandle:   Candle | null;     // candle being built
    trend:           TFTrend;
    swingHigh:       number | null;
    swingLow:        number | null;
    label:           string;            // for logging
}

// ─────────────────────────────────────────────────────────────────────────────
// MultiTimeframeAnalyzer
// ─────────────────────────────────────────────────────────────────────────────

export class MultiTimeframeAnalyzer {

    private tf5m:  TFState;
    private tf15m: TFState;
    private tf1h:  TFState;

    constructor() {
        this.tf5m  = this.createTFState(5 * 60_000,  MAX_5M_CANDLES,  MIN_5M_CANDLES,  '5M');
        this.tf15m = this.createTFState(15 * 60_000, MAX_15M_CANDLES, MIN_15M_CANDLES, '15M');
        this.tf1h  = this.createTFState(60 * 60_000, MAX_1H_CANDLES,  MIN_1H_CANDLES,  '1H');
    }

    private createTFState(intervalMs: number, maxCandles: number, minCandles: number, label: string): TFState {
        return {
            intervalMs,
            candles:       [],
            maxCandles,
            minCandles,
            currentCandle: null,
            trend:         'Neutral',
            swingHigh:     null,
            swingLow:      null,
            label,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Public API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Feed a completed 1-minute candle. Internally aggregates into 5m/15m/1h
     * and re-analyzes swing structure when a HTF candle closes.
     */
    public analyze(candle1m: Candle): void {
        this.feedCandle(this.tf5m,  candle1m);
        this.feedCandle(this.tf15m, candle1m);
        this.feedCandle(this.tf1h,  candle1m);
    }

    /**
     * Bulk hydrate from historical 1m candles (must be sorted ascending by timestamp).
     * Silently builds all HTF candles — no log spam during hydration.
     */
    public hydrateFrom1mCandles(candles: Candle[]): void {
        for (const c of candles) {
            this.feedCandle(this.tf5m,  c, true);
            this.feedCandle(this.tf15m, c, true);
            this.feedCandle(this.tf1h,  c, true);
        }
        // Force-close any partial candles left from hydration
        this.flushPartial(this.tf5m);
        this.flushPartial(this.tf15m);
        this.flushPartial(this.tf1h);

        console.log(
            `[MTF] 💧 Hydrated: ${this.tf1h.candles.length} 1H | ` +
            `${this.tf15m.candles.length} 15M | ${this.tf5m.candles.length} 5M candles`
        );
    }

    /** Get the current multi-timeframe bias snapshot. */
    public getSnapshot(): MTFSnapshot {
        const tf1h  = this.toBias(this.tf1h);
        const tf15m = this.toBias(this.tf15m);
        const tf5m  = this.toBias(this.tf5m);

        // Count alignment
        let bullish = 0, bearish = 0;
        for (const b of [tf1h, tf15m, tf5m]) {
            if (b.trend === 'Bullish') bullish++;
            if (b.trend === 'Bearish') bearish++;
        }

        const alignmentScore = Math.max(bullish, bearish);
        const dominantBias: TFTrend = bullish > bearish ? 'Bullish'
                                    : bearish > bullish ? 'Bearish'
                                    : 'Neutral';

        const isReady = this.tf1h.candles.length >= this.tf1h.minCandles
                     && this.tf15m.candles.length >= this.tf15m.minCandles
                     && this.tf5m.candles.length >= this.tf5m.minCandles;

        return { tf1h, tf15m, tf5m, alignmentScore, dominantBias, isReady };
    }

    /** Are all TFs warmed up with minimum candles? */
    public isReady(): boolean {
        return this.tf1h.candles.length >= this.tf1h.minCandles
            && this.tf15m.candles.length >= this.tf15m.minCandles
            && this.tf5m.candles.length >= this.tf5m.minCandles;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Candle Aggregation
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Feed a 1m candle into a higher-TF aggregator. When the HTF candle
     * boundary is crossed, the completed candle is pushed to the ring buffer
     * and swing structure is re-analyzed.
     */
    private feedCandle(tf: TFState, candle1m: Candle, silent: boolean = false): void {
        const candleStart = Math.floor(candle1m.timestamp / tf.intervalMs) * tf.intervalMs;

        if (!tf.currentCandle || tf.currentCandle.timestamp !== candleStart) {
            // New TF candle boundary — close the previous one
            if (tf.currentCandle) {
                tf.candles.push(tf.currentCandle);
                if (tf.candles.length > tf.maxCandles) tf.candles.shift();
                this.reanalyzeSwings(tf, silent);
            }
            // Start new TF candle
            tf.currentCandle = {
                open:      candle1m.open,
                high:      candle1m.high,
                low:       candle1m.low,
                close:     candle1m.close,
                volume:    candle1m.volume,
                buyVolume: candle1m.buyVolume,
                sellVolume: candle1m.sellVolume,
                timestamp: candleStart,
            };
        } else {
            // Same TF candle — update OHLCV + delta
            tf.currentCandle.high   = Math.max(tf.currentCandle.high, candle1m.high);
            tf.currentCandle.low    = Math.min(tf.currentCandle.low,  candle1m.low);
            tf.currentCandle.close  = candle1m.close;
            tf.currentCandle.volume    += candle1m.volume;
            tf.currentCandle.buyVolume  += candle1m.buyVolume;
            tf.currentCandle.sellVolume += candle1m.sellVolume;
        }
    }

    /** Flush a partial candle (used after hydration to capture the last incomplete candle). */
    private flushPartial(tf: TFState): void {
        if (tf.currentCandle) {
            tf.candles.push(tf.currentCandle);
            if (tf.candles.length > tf.maxCandles) tf.candles.shift();
            tf.currentCandle = null;
            this.reanalyzeSwings(tf, true);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Swing Structure Detection — 3-Bar Pivot
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Detects swing highs/lows using 3-bar pivots, then classifies trend
     * based on the last 2 swing points:
     *   HH + HL = Bullish
     *   LH + LL = Bearish
     *   Otherwise = Neutral
     */
    private reanalyzeSwings(tf: TFState, silent: boolean): void {
        const candles = tf.candles;
        const len = candles.length;
        if (len < PIVOT_BARS * 2 + 1) {
            tf.trend = 'Neutral';
            return;
        }

        // Find swing highs and lows (3-bar pivot: higher/lower than N bars on each side)
        const swingHighs: { price: number; idx: number }[] = [];
        const swingLows:  { price: number; idx: number }[] = [];

        for (let i = PIVOT_BARS; i < len - PIVOT_BARS; i++) {
            let isSwingHigh = true;
            let isSwingLow  = true;

            for (let j = 1; j <= PIVOT_BARS; j++) {
                if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
                    isSwingHigh = false;
                }
                if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
                    isSwingLow = false;
                }
            }

            if (isSwingHigh) swingHighs.push({ price: candles[i].high, idx: i });
            if (isSwingLow)  swingLows.push({ price: candles[i].low,   idx: i });
        }

        // Update most recent swing high/low
        tf.swingHigh = swingHighs.length > 0 ? swingHighs[swingHighs.length - 1].price : null;
        tf.swingLow  = swingLows.length  > 0 ? swingLows[swingLows.length - 1].price  : null;

        // Classify trend from last 2 swing highs and last 2 swing lows
        const prevTrend = tf.trend;
        tf.trend = this.classifyTrend(swingHighs, swingLows);
    }

    /**
     * HH + HL = Bullish
     * LH + LL = Bearish
     * Otherwise = Neutral
     */
    private classifyTrend(
        swingHighs: { price: number; idx: number }[],
        swingLows:  { price: number; idx: number }[],
    ): TFTrend {
        const hasHH = swingHighs.length >= 2 &&
            swingHighs[swingHighs.length - 1].price > swingHighs[swingHighs.length - 2].price;
        const hasHL = swingLows.length >= 2 &&
            swingLows[swingLows.length - 1].price > swingLows[swingLows.length - 2].price;
        const hasLH = swingHighs.length >= 2 &&
            swingHighs[swingHighs.length - 1].price < swingHighs[swingHighs.length - 2].price;
        const hasLL = swingLows.length >= 2 &&
            swingLows[swingLows.length - 1].price < swingLows[swingLows.length - 2].price;

        if (hasHH && hasHL) return 'Bullish';
        if (hasLH && hasLL) return 'Bearish';

        // Mixed/choppy structure — no directional bias, sit out
        return 'Neutral';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private toBias(tf: TFState): TFBias {
        return {
            trend:       tf.trend,
            swingHigh:   tf.swingHigh,
            swingLow:    tf.swingLow,
            lastClose:   tf.candles.length > 0 ? tf.candles[tf.candles.length - 1].close : 0,
            candleCount: tf.candles.length,
        };
    }

    /**
     * Scores HTF alignment for the probability model.
     *
     * ICT scalping hierarchy (15M is the directional anchor):
     *   15M aligned: +15pts (primary bias — fastest reliable structure)
     *   5M aligned:  +10pts (structure confirmation)
     *   1H aligned:  +5pts  (bonus — too slow for intraday, but adds confidence)
     *   Neutral TFs get half credit.
     *
     * @returns 0-30 score
     */
    public scoreAlignment(action: 'BUY' | 'SELL'): number {
        const direction: TFTrend = action === 'BUY' ? 'Bullish' : 'Bearish';
        let score = 0;

        // 5M bias — primary intraday anchor (15pts)
        if (this.tf5m.trend === direction) score += 15;
        else if (this.tf5m.trend === 'Neutral') score += 8;

        // 15M structure confirmation (10pts)
        if (this.tf15m.trend === direction) score += 10;
        else if (this.tf15m.trend === 'Neutral') score += 5;

        // 1H bonus alignment (5pts) — demoted from primary due to 3hr pivot lag
        if (this.tf1h.trend === direction) score += 5;
        else if (this.tf1h.trend === 'Neutral') score += 2;

        return score;
    }
}
