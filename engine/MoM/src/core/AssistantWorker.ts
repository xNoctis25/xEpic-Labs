/**
 * AssistantWorker.ts — Core 2
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • Tactical Overwatch — when MoM is IN_TRADE, monitors order flow for
 *     toxic reversions. Fires IMMINENT_REVERSION to MomWorker on detection.
 *   • Nova AI assistant relay — routes dashboard queries to LLM (Phase 4).
 *
 * IPC Ports (wired by Main/Core 4 via MessageChannel):
 *   • momPort    – MessagePort ↔ MomWorker    (send IMMINENT_REVERSION)
 *   • oraclePort – MessagePort ↔ Oracle (receive ticks + oracle_state)
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
// SECTION 1 — TACTICAL OVERWATCH
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

/** Handles messages from Oracle (ticks + oracle state). */
function onOracleMessage(msg: { type: string; [key: string]: unknown }): void {
    switch (msg.type) {

        case 'market_context': {
            const tick = msg.payload as EnrichedTick;
            if (!tick || tick.dataset !== 'GLBX.MDP3') return;  // CME only

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

        case 'SYSTEM_RESET': {
            activePosition  = null;
            overwatchMode   = 'IDLE';
            overwatchBuffer.length = 0;
            break;
        }

        case 'HYDRATION': {
            // Hydration data received — no ORB to hydrate, overwatch starts clean
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
         * complete to Oracle to begin the final sweep.
         */
        case 'SWEEP_PHASE_1_COMPLETE': {
            const sweep = msg.payload as { symbol: string; reason: string; ts: number };
            lastSweepReason = (msg.payload as any).reason || 'UNKNOWN';
            console.log(`[M.o.M] 🧹 Triple-Sweep P2 — verifying ${sweep.symbol}...`);

            // Wait 5s for Phase 1 flatten to settle before verifying
            setTimeout(() => {
                parentPort!.postMessage({
                    type:   'VERIFY_FLAT',
                    phase:  2,
                    symbol: sweep.symbol,
                    from:   'AssistantWorker',
                });
            }, 5000);
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
            break;
        }

        case 'query': {
            handleAssistantQuery(msg.payload as string);
            break;
        }

        /**
         * VERIFY_FLAT_RESULT — Main (Core 4) responds with Tradovate position check.
         * If flat confirmed, fire SWEEP_PHASE_2_COMPLETE to Oracle.
         */
        case 'VERIFY_FLAT_RESULT': {
            if ((msg.from as string) !== 'AssistantWorker') break;
            const isFlat = msg.isFlat as boolean;
            const symbol = msg.symbol as string;

            if (isFlat) {
                console.log(`[AssistantWorker] ✅ Phase 2 verified — ${symbol} is FLAT. Firing SWEEP_PHASE_2_COMPLETE → Oracle.`);
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

        case 'HUNTING_ACTIVE': break;  // Acknowledged — MomWorker gates trades

        case 'shutdown': {
            console.log('[AssistantWorker] Shutting down…');
            momPort?.close();
            oraclePort?.close();
            process.exit(0);
            break;
        }

        default:
            console.warn(`[AssistantWorker] Unknown message type: ${msg.type}`);
    }
});
