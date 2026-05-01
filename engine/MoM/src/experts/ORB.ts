import { EnrichedTick } from '../services/DatabentoLiveService';

/** A single OHLCV bucket for consolidation box tracking. */
export interface OhlcvBucket {
    open:   number;
    high:   number;
    low:    number;
    close:  number;
    volume: number;
    start:  number;   // epoch ms
    ticks:  number;
}

/** The ORB setup payload sent to MomWorker for execution approval. */
export interface OrbSetup {
    symbol:         string;
    dataset:        string;
    breakoutPrice:  number;       // price at breakout moment
    breakoutVolume: number;       // tick volume that confirmed the break
    direction:      'LONG' | 'SHORT';
    boxHigh:        number;       // consolidation box high
    boxLow:         number;       // consolidation box low
    volumeRatio:    number;       // breakoutVolume / rollingAvgVolume
    ts:             number;       // epoch ms
}

// ── Scanner constants ────────────────────────────────────────────────────────
const BUCKET_MS            = 60_000;    // 1-minute buckets for consolidation box
const BOX_LOOKBACK_BUCKETS = 5;         // build box from last N complete 1-min buckets
const VOLUME_SPIKE_RATIO   = 1.5;       // anomaly threshold: 1.5× rolling avg bucket volume
const ROLLING_VOL_BUCKETS  = 20;        // rolling average window (buckets)
const ATR_ORB_PERIOD       = 14;        // ATR lookback for dynamic box threshold
const BOX_ATR_MULT         = 0.5;       // box must be tighter than ATR * 0.5

interface OrbSymbolState {
    currentBucket:   OhlcvBucket | null;
    completeBuckets: OhlcvBucket[];     // ring buffer of complete buckets
    rollingVolumes:  number[];           // per-bucket total volumes for avg calc
    atrValues:       number[];           // rolling TR values for ATR calculation
    currentATR:      number;             // current 14-period ATR
    isWarmedUp?:     boolean;
}

export class ORB {
    private orbState = new Map<string, OrbSymbolState>();
    private onWarmupComplete?: () => void;

    constructor(onWarmupComplete?: () => void) {
        this.onWarmupComplete = onWarmupComplete;
    }

    private getOrbState(symbol: string): OrbSymbolState {
        if (!this.orbState.has(symbol)) {
            this.orbState.set(symbol, {
                currentBucket: null, completeBuckets: [], rollingVolumes: [],
                atrValues: [], currentATR: 0,
            });
        }
        return this.orbState.get(symbol)!;
    }

    private rollingAvgVolume(volumes: number[]): number {
        if (volumes.length === 0) return 0;
        return volumes.reduce((a, b) => a + b, 0) / volumes.length;
    }

    public analyze(tick: EnrichedTick): OrbSetup | null {
        const sym   = tick.symbol;
        const state = this.getOrbState(sym);
        const now   = tick.timestamp;

        // ── Open or advance the current 1-min bucket ─────────────────────────────
        if (!state.currentBucket || now - state.currentBucket.start >= BUCKET_MS) {
            if (state.currentBucket) {
                const closedBucket = state.currentBucket;

                // Close the bucket
                state.completeBuckets.push(closedBucket);
                state.rollingVolumes.push(closedBucket.volume);

                // Update ATR from completed buckets
                const cLen = state.completeBuckets.length;
                if (cLen >= 2) {
                    const prev = state.completeBuckets[cLen - 2];
                    const tr = Math.max(
                        closedBucket.high - closedBucket.low,
                        Math.abs(closedBucket.high - prev.close),
                        Math.abs(closedBucket.low - prev.close),
                    );
                    state.atrValues.push(tr);
                    if (state.atrValues.length > ATR_ORB_PERIOD) state.atrValues.shift();
                    state.currentATR = state.atrValues.reduce((a, b) => a + b, 0) / state.atrValues.length;
                }

                if (state.rollingVolumes.length === ROLLING_VOL_BUCKETS && !state.isWarmedUp) {
                    state.isWarmedUp = true;
                    if (this.onWarmupComplete) this.onWarmupComplete();
                }

                // Trim ring buffers
                if (state.completeBuckets.length > ROLLING_VOL_BUCKETS + BOX_LOOKBACK_BUCKETS) {
                    state.completeBuckets.shift();
                }
                if (state.rollingVolumes.length > ROLLING_VOL_BUCKETS) {
                    state.rollingVolumes.shift();
                }
            }
            // Open new bucket
            state.currentBucket = {
                open: tick.price, high: tick.price,
                low:  tick.price, close: tick.price,
                volume: tick.volume, start: now, ticks: 1,
            };
            return null;  // need at least one tick inside to compute an anomaly
        }

        // ── Update current bucket ─────────────────────────────────────────────────
        const b = state.currentBucket;
        b.high   = Math.max(b.high, tick.price);
        b.low    = Math.min(b.low,  tick.price);
        b.close  = tick.price;
        b.volume += tick.volume;
        b.ticks++;

        // Need enough history to build a consolidation box
        if (state.completeBuckets.length < BOX_LOOKBACK_BUCKETS) return null;

        const boxBuckets = state.completeBuckets.slice(-BOX_LOOKBACK_BUCKETS);
        const boxHigh    = Math.max(...boxBuckets.map(x => x.high));
        const boxLow     = Math.min(...boxBuckets.map(x => x.low));
        const boxRange   = boxHigh - boxLow;  // absolute points

        // ── ATR-dynamic box tightness check ───────────────────────────────────────
        // Box must be tighter than ATR * 0.5 (adapts to current volatility)
        const boxThreshold = state.currentATR > 0 ? state.currentATR * BOX_ATR_MULT : boxRange + 1;
        if (boxRange > boxThreshold) return null;

        if (state.rollingVolumes.length < ROLLING_VOL_BUCKETS) return null;

        // ── Volume anomaly check (BUCKET volume, not single tick) ─────────────────
        const avgVol = this.rollingAvgVolume(state.rollingVolumes);
        if (avgVol === 0) return null;

        // Compare the CURRENT BUCKET's accumulated volume against the rolling avg
        const volRatio = b.volume / avgVol;
        if (volRatio < VOLUME_SPIKE_RATIO) return null;

        // ── Breakout direction ────────────────────────────────────────────────────
        let direction: 'LONG' | 'SHORT' | null = null;
        if (tick.price > boxHigh) direction = 'LONG';
        if (tick.price < boxLow)  direction = 'SHORT';
        if (!direction) return null;

        // ── Construct and send ORB_SETUP to MomWorker ─────────────────────────────
        const setup: OrbSetup = {
            symbol:         sym,
            dataset:        tick.dataset,
            breakoutPrice:  tick.price,
            breakoutVolume: b.volume,
            direction,
            boxHigh,
            boxLow,
            volumeRatio:    volRatio,
            ts:             now,
        };

        console.log(
            `[ORB] 🔭 ORB_SETUP detected | ${sym} ${direction} | ` +
            `Bucket Vol: ${b.volume} (${volRatio.toFixed(2)}× avg) | ` +
            `Box: [${boxLow.toFixed(2)}, ${boxHigh.toFixed(2)}] (range: ${boxRange.toFixed(2)}, ATR: ${state.currentATR.toFixed(2)}) | ` +
            `Breakout @ ${tick.price.toFixed(2)}`
        );

        return setup;
    }

    public hydrate(cmeCandles: any[]): void {
        for (const c of cmeCandles) {
            const state = this.getOrbState(c.symbol);
            state.completeBuckets.push({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, start: c.timestamp, ticks: 4 });
            state.rollingVolumes.push(c.volume);
            // Use local copies of constants since we are in ORB class
            if (state.completeBuckets.length > ROLLING_VOL_BUCKETS + BOX_LOOKBACK_BUCKETS) state.completeBuckets.shift();
            if (state.rollingVolumes.length > ROLLING_VOL_BUCKETS) state.rollingVolumes.shift();
        }
        console.log(`[ORB] 💧 Hydrated: ${cmeCandles.length} CME candles into ORB scanner.`);
    }

    public reset(): void {
        this.orbState.clear();
        console.log('[ORB] 🔭 SYSTEM_RESET — ORB Hunter re-armed for next cycle.');
    }
}
