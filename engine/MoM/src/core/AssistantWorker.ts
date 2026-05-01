/**
 * AssistantWorker.ts — Core 2
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • 24/7 ORB Volume Hunter — scans every tick for volume anomalies breaking
 *     out of a tight consolidation box. Fires ORB_SETUP to MomWorker.
 *   • Tactical Overwatch — when MoM is IN_TRADE, monitors order flow for
 *     toxic reversions. Fires IMMINENT_REVERSION to MomWorker on detection.
 *   • Nova AI assistant relay — routes dashboard queries to LLM (Phase 4).
 *
 * IPC Ports (wired by Main/Core 4 via MessageChannel):
 *   • momPort    – MessagePort ↔ MomWorker    (send ORB_SETUP, IMMINENT_REVERSION)
 *   • oraclePort – MessagePort ↔ OracleWorker (receive ticks + oracle_state)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parentPort, MessagePort } from 'worker_threads';
import { EnrichedTick }            from '../services/DatabentoLiveService';

if (!parentPort) throw new Error('[AssistantWorker] Must be run as a worker thread.');

// ─── IPC Peer Ports ──────────────────────────────────────────────────────────
let momPort:    MessagePort | null = null;
let oraclePort: MessagePort | null = null;
let lastSweepReason = '';

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — ORB VOLUME HUNTER (24/7)
// ─────────────────────────────────────────────────────────────────────────────

/** A single OHLCV bucket for consolidation box tracking. */
interface OhlcvBucket {
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
const VOLUME_SPIKE_RATIO   = 1.5;       // anomaly threshold: 1.5× rolling avg
const ROLLING_VOL_BUCKETS  = 20;        // rolling average window (buckets)
const BOX_TIGHT_THRESHOLD  = 0.0015;    // max box range / midpoint (0.15%) to be "tight"

// ── Per-symbol ORB state ─────────────────────────────────────────────────────
interface OrbSymbolState {
    currentBucket:  OhlcvBucket | null;
    completeBuckets: OhlcvBucket[];     // ring buffer of complete buckets
    rollingVolumes:  number[];           // per-bucket total volumes for avg calc
    isWarmedUp?:     boolean;
}

const orbState = new Map<string, OrbSymbolState>();

function getOrbState(symbol: string): OrbSymbolState {
    if (!orbState.has(symbol)) {
        orbState.set(symbol, { currentBucket: null, completeBuckets: [], rollingVolumes: [] });
    }
    return orbState.get(symbol)!;
}

/** Rolling average of the last N bucket volumes. */
function rollingAvgVolume(volumes: number[]): number {
    if (volumes.length === 0) return 0;
    return volumes.reduce((a, b) => a + b, 0) / volumes.length;
}

/**
 * Called for every CME tick. Aggregates into 1-minute OHLCV buckets,
 * calculates the consolidation box, and checks for volume-anomaly breakouts.
 */
function processOrbTick(tick: EnrichedTick): void {
    const sym   = tick.symbol;
    const state = getOrbState(sym);
    const now   = tick.timestamp;

    // ── Open or advance the current 1-min bucket ─────────────────────────────
    if (!state.currentBucket || now - state.currentBucket.start >= BUCKET_MS) {
        if (state.currentBucket) {
            // Close the bucket
            state.completeBuckets.push(state.currentBucket);
            state.rollingVolumes.push(state.currentBucket.volume);

            if (state.rollingVolumes.length === ROLLING_VOL_BUCKETS && !state.isWarmedUp) {
                state.isWarmedUp = true;
                parentPort!.postMessage({ type: 'WARMUP_COMPLETE' });
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
        return;  // need at least one tick inside to compute an anomaly
    }

    // ── Update current bucket ─────────────────────────────────────────────────
    const b = state.currentBucket;
    b.high   = Math.max(b.high, tick.price);
    b.low    = Math.min(b.low,  tick.price);
    b.close  = tick.price;
    b.volume += tick.volume;
    b.ticks++;

    // Need enough history to build a consolidation box
    if (state.completeBuckets.length < BOX_LOOKBACK_BUCKETS) return;

    const boxBuckets = state.completeBuckets.slice(-BOX_LOOKBACK_BUCKETS);
    const boxHigh    = Math.max(...boxBuckets.map(x => x.high));
    const boxLow     = Math.min(...boxBuckets.map(x => x.low));
    const midpoint   = (boxHigh + boxLow) / 2;
    const boxRange   = (boxHigh - boxLow) / midpoint;

    // Only scan "tight" consolidation ranges
    if (boxRange > BOX_TIGHT_THRESHOLD) return;

    if (state.rollingVolumes.length < ROLLING_VOL_BUCKETS) return;

    // ── Volume anomaly check ──────────────────────────────────────────────────
    const avgVol   = rollingAvgVolume(state.rollingVolumes);
    if (avgVol === 0) return;

    const volRatio = tick.volume / avgVol;
    if (volRatio < VOLUME_SPIKE_RATIO) return;

    // ── Breakout direction ────────────────────────────────────────────────────
    let direction: 'LONG' | 'SHORT' | null = null;
    if (tick.price > boxHigh) direction = 'LONG';
    if (tick.price < boxLow)  direction = 'SHORT';
    if (!direction) return;

    // ── Construct and send ORB_SETUP to MomWorker ─────────────────────────────
    const setup: OrbSetup = {
        symbol:         sym,
        dataset:        tick.dataset,
        breakoutPrice:  tick.price,
        breakoutVolume: tick.volume,
        direction,
        boxHigh,
        boxLow,
        volumeRatio:    volRatio,
        ts:             now,
    };

    console.log(
        `[AssistantWorker] 🔭 ORB_SETUP detected | ${sym} ${direction} | ` +
        `Vol ratio: ${volRatio.toFixed(2)}× | Box: [${boxLow.toFixed(2)}, ${boxHigh.toFixed(2)}] | ` +
        `Breakout @ ${tick.price.toFixed(2)}`
    );

    momPort?.postMessage({ type: 'ORB_SETUP', payload: setup });

    // Notify dashboard via Main
    parentPort!.postMessage({ type: 'orb_alert', payload: setup });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — TACTICAL OVERWATCH
// ─────────────────────────────────────────────────────────────────────────────

/** Current position being monitored by Tactical Overwatch. */
interface ActivePosition {
    symbol:      string;
    direction:   'LONG' | 'SHORT';
    entryPrice:  number;
    entryTs:     number;
    stopPrice:   number;
}

type OverwatchMode = 'IDLE' | 'WATCHING';

let overwatchMode: OverwatchMode    = 'IDLE';
let activePosition: ActivePosition | null = null;

// ── Reversion detection constants ────────────────────────────────────────────
const TOXIC_VOLUME_RATIO       = 2.0;    // opposing volume ≥ 2× avg → toxic
const REVERSION_WINDOW_TICKS   = 30;     // evaluate over last N ticks while in-trade
const REVERSION_PRICE_RATIO    = 0.003;  // price moved 0.3% against us = structural concern

/** Rolling tick buffer used during Tactical Overwatch. */
interface TickSample { price: number; volume: number; direction: 'BUY' | 'SELL'; ts: number; }
const overwatchBuffer: TickSample[] = [];

/**
 * Called for every CME tick while `overwatchMode === 'WATCHING'`.
 * Detects toxic reversion via opposing volume sweeps + price momentum.
 */
function evaluateOverwatch(tick: EnrichedTick): void {
    if (!activePosition) return;

    // Infer tick aggressor direction from price delta (simplified)
    const prevClose = overwatchBuffer.length > 0
        ? overwatchBuffer[overwatchBuffer.length - 1].price
        : activePosition.entryPrice;
    const tickDir: 'BUY' | 'SELL' = tick.price >= prevClose ? 'BUY' : 'SELL';

    overwatchBuffer.push({ price: tick.price, volume: tick.volume, direction: tickDir, ts: tick.timestamp });
    if (overwatchBuffer.length > REVERSION_WINDOW_TICKS) overwatchBuffer.shift();
    if (overwatchBuffer.length < 10) return;  // need minimum sample

    // ── Opposing volume sweep check ───────────────────────────────────────────
    const opposingDir: 'BUY' | 'SELL' = activePosition.direction === 'LONG' ? 'SELL' : 'BUY';
    const opposingTicks  = overwatchBuffer.filter(t => t.direction === opposingDir);
    const friendlyTicks  = overwatchBuffer.filter(t => t.direction !== opposingDir);

    const avgOpposing  = opposingTicks.reduce((s, t) => s + t.volume, 0) / (opposingTicks.length || 1);
    const avgFriendly  = friendlyTicks.reduce((s, t) => s + t.volume, 0) / (friendlyTicks.length || 1);

    const volumeRatio  = avgFriendly > 0 ? avgOpposing / avgFriendly : 0;

    // ── Price momentum check ─────────────────────────────────────────────────
    const oldest         = overwatchBuffer[0].price;
    const newest         = overwatchBuffer[overwatchBuffer.length - 1].price;
    const priceDelta     = (newest - oldest) / oldest;
    const isAgainstUs    = activePosition.direction === 'LONG' ? priceDelta < 0 : priceDelta > 0;
    const priceMovePct   = Math.abs(priceDelta);

    // ── Toxic reversion = massive opposing volume sweep + adverse price move ──
    const isToxicVolume  = volumeRatio >= TOXIC_VOLUME_RATIO;
    const isToxicPrice   = isAgainstUs && priceMovePct >= REVERSION_PRICE_RATIO;

    if (isToxicVolume && isToxicPrice) {
        console.warn(
            `[AssistantWorker] 🚨 IMMINENT_REVERSION | ${activePosition.symbol} ${activePosition.direction} | ` +
            `OppVol ratio: ${volumeRatio.toFixed(2)}× | Price Δ: ${(priceDelta * 100).toFixed(3)}%`
        );

        momPort?.postMessage({
            type: 'IMMINENT_REVERSION',
            payload: {
                symbol:       activePosition.symbol,
                direction:    activePosition.direction,
                entryPrice:   activePosition.entryPrice,
                currentPrice: tick.price,
                volumeRatio,
                priceDeltaPct: priceDelta * 100,
                ts:           tick.timestamp,
            },
        });

        // Notify dashboard
        parentPort!.postMessage({
            type: 'overwatch_alert',
            payload: { level: 'TOXIC', volumeRatio, priceDeltaPct: priceDelta * 100 },
        });

        // Cool-down: clear buffer to avoid repeated fires on same reversion
        overwatchBuffer.length = 0;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — IPC MESSAGE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

/** Handles messages from OracleWorker (ticks + oracle state). */
function onOracleMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {

        case 'market_context': {
            const tick = msg.payload as EnrichedTick;
            if (!tick || tick.dataset !== 'GLBX.MDP3') return;  // CME only

            // 24/7 ORB scanner
            processOrbTick(tick);

            // Tactical Overwatch (only when in a live trade)
            if (overwatchMode === 'WATCHING') evaluateOverwatch(tick);
            break;
        }

        case 'oracle_state': {
            // Store oracle state for LLM context (Phase 5)
            break;
        }

        case 'defcon_change': {
            const level = msg.level as string;
            console.log(`[AssistantWorker] DefconLevel → ${level} | Reason: ${msg.reason}`);
            if (level === 'RED' && overwatchMode === 'WATCHING') {
                momPort?.postMessage({ type: 'DEFCON_RED', reason: msg.reason });
            }
            break;
        }

        /**
         * SYSTEM_RESET — OracleWorker confirmed Triple-Sweep complete.
         * Re-arm all scanners for the next hunt cycle.
         */
        case 'SYSTEM_RESET': {
            console.log('[AssistantWorker] 🔭 SYSTEM_RESET — ORB Hunter re-armed for next cycle.');
            activePosition  = null;
            overwatchMode   = 'IDLE';
            overwatchBuffer.length = 0;
            orbState.clear();   // clear bucketed history for clean re-start
            break;
        }

        default: break;
    }
}

/** Handles messages from MomWorker (engine state + trade lifecycle). */
function onMomMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {

        /**
         * IN_TRADE — MomWorker has entered a position.
         * Switch to Tactical Overwatch mode.
         */
        case 'IN_TRADE': {
            const p = msg.payload as ActivePosition;
            activePosition  = p;
            overwatchMode   = 'WATCHING';
            overwatchBuffer.length = 0;
            console.log(
                `[AssistantWorker] 🎯 Tactical Overwatch ACTIVE | ` +
                `${p.symbol} ${p.direction} @ ${p.entryPrice}`
            );
            parentPort!.postMessage({ type: 'overwatch_status', mode: 'WATCHING', position: p });
            break;
        }

        /**
         * TRADE_CLOSED — MomWorker exited a position (used for overwatch teardown).
         */
        case 'TRADE_CLOSED': {
            console.log(
                `[AssistantWorker] ✅ Trade closed | ` +
                `${activePosition?.symbol ?? '?'} — reverting to ORB hunt mode.`
            );
            activePosition  = null;
            overwatchMode   = 'IDLE';
            overwatchBuffer.length = 0;
            parentPort!.postMessage({ type: 'overwatch_status', mode: 'IDLE' });
            break;
        }

        /**
         * SWEEP_PHASE_1_COMPLETE — MomWorker cancelled local orders.
         * Phase 2: Query Tradovate via Main to confirm 0 positions, then fire Phase 2
         * complete to OracleWorker to begin the final sweep.
         */
        case 'SWEEP_PHASE_1_COMPLETE': {
            const sweep = msg.payload as { symbol: string; reason: string; ts: number };
            lastSweepReason = (msg.payload as any).reason || 'UNKNOWN';
            console.log(`[AssistantWorker] 🧹 Triple-Sweep PHASE 2 — Verifying flat state for ${sweep.symbol}…`);

            // Request a position check from Main (Core 4) which holds the broker
            parentPort!.postMessage({
                type:   'VERIFY_FLAT',
                phase:  2,
                symbol: sweep.symbol,
                from:   'AssistantWorker',
            });

            // VERIFY_FLAT_RESULT is handled in the parentPort listener below
            break;
        }

        /**
         * engine_state — general status updates (evaluating, idle, etc.)
         */
        case 'engine_state': {
            // Store for LLM context (Phase 4)
            break;
        }

        default: break;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — NOVA AI RELAY (Phase 4 stub)
// ─────────────────────────────────────────────────────────────────────────────
async function handleAssistantQuery(question: string): Promise<void> {
    console.log(`[AssistantWorker] 🤖 Nova query: "${question}"`);
    // TODO Phase 4: inject Gemini LLM + RAG context (ORB history, oracle state)
    parentPort!.postMessage({
        type:    'assistant_response',
        payload: `[Nova stub] Query received: "${question}"`,
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — MAIN IPC HANDLER (from Core 4)
// ─────────────────────────────────────────────────────────────────────────────
parentPort.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {

        case 'init': {
            momPort    = msg.momPort    as MessagePort;
            oraclePort = msg.oraclePort as MessagePort;

            momPort   .on('message', onMomMessage);
            oraclePort.on('message', onOracleMessage);

            parentPort!.postMessage({ type: 'ready', worker: 'AssistantWorker' });
            console.log('[AssistantWorker] Core 2 online — ORB Hunter + Tactical Overwatch + Triple-Sweep wired.');
            break;
        }

        case 'query': {
            handleAssistantQuery(msg.payload as string);
            break;
        }

        /**
         * VERIFY_FLAT_RESULT — Main (Core 4) responds with Tradovate position check.
         * If flat confirmed, fire SWEEP_PHASE_2_COMPLETE to OracleWorker.
         */
        case 'VERIFY_FLAT_RESULT': {
            if ((msg.from as string) !== 'AssistantWorker') break;
            const isFlat = msg.isFlat as boolean;
            const symbol = msg.symbol as string;

            if (isFlat) {
                console.log(`[AssistantWorker] ✅ Phase 2 verified — ${symbol} is FLAT. Firing SWEEP_PHASE_2_COMPLETE → OracleWorker.`);
                oraclePort?.postMessage({
                    type:    'SWEEP_PHASE_2_COMPLETE',
                    payload: { symbol, confirmed: true, reason: lastSweepReason, ts: Date.now() },
                });
            } else {
                console.error(
                    `[AssistantWorker] ❌ Phase 2 FAILED — ${symbol} still shows open positions! ` +
                    `Requesting EMERGENCY_EXIT via Main.`
                );
                parentPort!.postMessage({
                    type:    'trade_command',
                    payload: { action: 'FLATTEN_ALL', symbol, reason: 'TRIPLE_SWEEP_PHASE2_DISCREPANCY' },
                });
            }
            break;
        }

        /**
         * hydration_payload — sent by Core 4 before live feeds start.
         * Directly injects historical OHLCV buckets into the ORB scanner state
         * so consolidation boxes and rolling volume averages are pre-filled.
         */
        case 'hydration_payload': {
            const { cmeCandles } = msg.payload as {
                cmeCandles: Array<{ open: number; high: number; low: number; close: number; volume: number; timestamp: number; symbol: string }>;
            };

            // Group by symbol, then push directly into completeBuckets + rollingVolumes
            for (const c of cmeCandles) {
                const state = getOrbState(c.symbol);

                const bucket = {
                    open: c.open, high: c.high, low: c.low, close: c.close,
                    volume: c.volume, start: c.timestamp, ticks: 4,
                };

                state.completeBuckets.push(bucket);
                state.rollingVolumes.push(c.volume);

                // Trim ring buffers to their configured max sizes
                if (state.completeBuckets.length > ROLLING_VOL_BUCKETS + BOX_LOOKBACK_BUCKETS) {
                    state.completeBuckets.shift();
                }
                if (state.rollingVolumes.length > ROLLING_VOL_BUCKETS) {
                    state.rollingVolumes.shift();
                }
            }

            const syms = [...new Set(cmeCandles.map(c => c.symbol))].join(', ');
            console.log(
                `[AssistantWorker] 💧 Hydrated: ${cmeCandles.length} CME candles ` +
                `into ORB scanner for [${syms}] — boxes + rolling volume primed.`
            );
            break;
        }

        case 'shutdown': {
            console.log('[AssistantWorker] Shutting down…');
            momPort?.close();
            oraclePort?.close();
            process.exit(0);
        }

        default:
            console.warn(`[AssistantWorker] Unknown message type: ${msg.type}`);
    }
});
