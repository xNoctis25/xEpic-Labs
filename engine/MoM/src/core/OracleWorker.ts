/**
 * OracleWorker.ts — Core 3
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • Owns the DatabentoLiveService — SOLE source of CME + CFE market data.
 *   • Multicasts every tick to MomWorker (momPort), AssistantWorker (assistPort),
 *     and Main/Core 4 (parentPort) with zero latency.
 *   • Runs the Macro Radar: VWAP-slope micro-trend bias + VIX spike tracking.
 *   • Maintains a DefconLevel (GREEN | RED) broadcast to all peers.
 *   • Hosts a WebSocket Server on port 8080 as the NOVA Receptionist:
 *       - HALT      → sets DefconLevel RED, blocks MomWorker signal processing
 *       - PULL_PLUG → fires EMERGENCY_EXIT directly to MomWorker via momPort
 *
 * IPC Ports received on startup (via parentPort 'init' message):
 *   • momPort    – MessagePort ↔ MomWorker    (write ticks + emergency commands)
 *   • assistPort – MessagePort ↔ AssistantWorker (write ticks + oracle state)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parentPort, MessagePort } from 'worker_threads';
import { WebSocketServer, WebSocket } from 'ws';
import { DatabentoLiveService, EnrichedTick, CFE_DATASET } from '../services/DatabentoLiveService';

if (!parentPort) throw new Error('[OracleWorker] Must be run as a worker thread.');

// ─── Constants ────────────────────────────────────────────────────────────────
const WSS_PORT          = 8080;
const VIX_RED_THRESHOLD = 25.0;      // VIX level that triggers DefconLevel RED (raised from 20)
const VWAP_WINDOW_MS    = 15 * 60_000;  // 15-minute rolling time window for VWAP
const VWAP_EMA_ALPHA    = 0.05;      // EMA decay — ~20-tick half-life (~2 min reactivity)

// ─── DefconLevel ─────────────────────────────────────────────────────────────
type DefconLevel = 'GREEN' | 'RED';
let defconLevel: DefconLevel = 'GREEN';

// ─── Peer ports (wired by Main via MessageChannel) ───────────────────────────
let momPort:    MessagePort | null = null;
let assistPort: MessagePort | null = null;
let lastSweepReason = '';

// ─── Databento service ───────────────────────────────────────────────────────
const feed = new DatabentoLiveService();

// ─── Macro Radar state ───────────────────────────────────────────────────────
interface VwapSample { price: number; volume: number; ts: number; }
const cmeVwapWindow: VwapSample[] = [];   // rolling window for ES/MES VWAP slope
let   lastVwap = 0;
let   vwapSlope = 0;          // EMA-smoothed VWAP slope (positive = bullish, negative = bearish)
let   lastVixPrice = 0;       // latest VX tick price (proxy for VIX level)

/** Calculate VWAP from a rolling window of ticks. */
function calcVwap(window: VwapSample[]): number {
    let sumPV = 0, sumV = 0;
    for (const s of window) { sumPV += s.price * s.volume; sumV += s.volume; }
    return sumV > 0 ? sumPV / sumV : 0;
}

/** Update rolling VWAP slope (15-min time window) and emit oracle state. */
function updateMacroRadar(tick: EnrichedTick): void {
    const isCfe = tick.dataset === CFE_DATASET;

    if (isCfe) {
        lastVixPrice = tick.price;
        if (lastVixPrice >= VIX_RED_THRESHOLD && defconLevel === 'GREEN') {
            defconLevel = 'RED';
            broadcastDefcon('RED', `VIX spike: ${lastVixPrice.toFixed(2)}`);
        }
        return;
    }

    // CME ticks → 15-minute rolling time window VWAP
    cmeVwapWindow.push({ price: tick.price, volume: tick.volume, ts: tick.timestamp });

    // Prune entries older than 15 minutes from the current tick timestamp
    const cutoff = tick.timestamp - VWAP_WINDOW_MS;
    while (cmeVwapWindow.length > 0 && cmeVwapWindow[0].ts < cutoff) {
        cmeVwapWindow.shift();
    }

    const currentVwap = calcVwap(cmeVwapWindow);
    if (lastVwap !== 0) {
        // EMA-weighted slope — reacts within 2 minutes instead of dragging 15 min of stale data
        const rawSlope = currentVwap - lastVwap;
        vwapSlope = VWAP_EMA_ALPHA * rawSlope + (1 - VWAP_EMA_ALPHA) * vwapSlope;
    }
    lastVwap = currentVwap;

    // Emit oracle state snapshot to AssistantWorker
    assistPort?.postMessage({
        type:     'oracle_state',
        defcon:   defconLevel,
        vwapSlope,
        vixLevel: lastVixPrice,
        ts:       tick.timestamp,
    });
}

/** Broadcast DefconLevel change to all peers and Main. */
function broadcastDefcon(level: DefconLevel, reason: string): void {
    console.log(`🚨 [OracleWorker] DefconLevel → ${level} | Reason: ${reason}`);
    const msg = { type: 'defcon_change', level, reason, ts: Date.now() };
    momPort?.postMessage(msg);
    assistPort?.postMessage(msg);
    parentPort!.postMessage(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tick Multicast Handler
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Called by DatabentoLiveService for EVERY tick from EITHER dataset.
 * Fan-out order:
 *   1. MomWorker   (direct peer port — lowest latency)
 *   2. AssistantWorker (direct peer port)
 *   3. Main/Core 4 (parentPort — for WebSocket delivery to dashboard)
 */
function onTick(tick: EnrichedTick): void {
    // ALWAYS multicast ticks to keep all workers' indicators primed.
    // DEFCON RED only suppresses execution (via MomWorker handshake), NOT data flow.

    // 1. Signal core — fire immediately (MomWorker uses DEFCON for handshake gating)
    momPort?.postMessage({ type: 'tick', payload: tick });

    // 2. Assistant — for context awareness
    assistPort?.postMessage({ type: 'market_context', payload: tick });

    // 3. Main — for live dashboard feed
    parentPort!.postMessage({ type: 'tick', payload: tick });

    // Update Macro Radar analytics (non-blocking; pure computation)
    updateMacroRadar(tick);
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Server — NOVA Receptionist (port 8080)
// ─────────────────────────────────────────────────────────────────────────────
function startWssReceptionist(): void {
    const wss = new WebSocketServer({ port: WSS_PORT });

    wss.on('listening', () => {
        console.log(`🛰️  [OracleWorker] WSS Receptionist listening on ws://localhost:${WSS_PORT}`);
    });

    wss.on('connection', (ws: WebSocket, req) => {
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        console.log(`🔗 [OracleWorker] NOVA connected from ${clientIp}`);

        // Send current state on connect
        ws.send(JSON.stringify({ type: 'oracle_hello', defcon: defconLevel, vixLevel: lastVixPrice }));

        ws.on('message', (raw) => {
            const cmd = raw.toString().trim().toUpperCase();
            console.log(`📨 [OracleWorker] NOVA command received: ${cmd}`);

            switch (cmd) {

                /**
                 * HALT — set DefconLevel to RED.
                 * Suppresses all tick flow to MomWorker until manually cleared.
                 */
                case 'HALT': {
                    defconLevel = 'RED';
                    broadcastDefcon('RED', 'NOVA HALT command');
                    ws.send(JSON.stringify({ type: 'ack', cmd: 'HALT', defcon: 'RED' }));
                    break;
                }

                /**
                 * PULL_PLUG — emergency exit.
                 * Blasts EMERGENCY_EXIT directly to MomWorker via momPort.
                 * MomWorker must immediately flatten all positions.
                 */
                case 'PULL_PLUG': {
                    console.error('🚨 [OracleWorker] PULL_PLUG — blasting EMERGENCY_EXIT to MomWorker!');
                    defconLevel = 'RED';
                    broadcastDefcon('RED', 'NOVA PULL_PLUG command');
                    momPort?.postMessage({ type: 'EMERGENCY_EXIT', reason: 'NOVA PULL_PLUG', ts: Date.now() });
                    ws.send(JSON.stringify({ type: 'ack', cmd: 'PULL_PLUG', defcon: 'RED' }));
                    break;
                }

                /**
                 * RESUME — clear DefconLevel back to GREEN (admin use).
                 */
                case 'RESUME': {
                    defconLevel = 'GREEN';
                    broadcastDefcon('GREEN', 'NOVA RESUME command');
                    ws.send(JSON.stringify({ type: 'ack', cmd: 'RESUME', defcon: 'GREEN' }));
                    break;
                }

                /**
                 * STATUS — return current oracle snapshot.
                 */
                case 'STATUS': {
                    ws.send(JSON.stringify({
                        type:      'status',
                        defcon:    defconLevel,
                        vixLevel:  lastVixPrice,
                        vwapSlope,
                        ts:        Date.now(),
                    }));
                    break;
                }

                default:
                    ws.send(JSON.stringify({ type: 'error', msg: `Unknown command: ${cmd}` }));
            }
        });

        ws.on('close', () => console.log(`🔌 [OracleWorker] NOVA client disconnected from ${clientIp}`));
        ws.on('error', (err) => console.error(`❌ [OracleWorker] WSS client error: ${err.message}`));
    });

    wss.on('error', (err) => {
        console.error(`❌ [OracleWorker] WSS error: ${err.message}`);
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Main IPC Handler (from Core 4 / Main Thread)
// ─────────────────────────────────────────────────────────────────────────────
parentPort.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {

        case 'init': {
            momPort    = msg.momPort    as MessagePort;
            assistPort = msg.assistPort as MessagePort;

            momPort   .on('message', onMomMessage);
            assistPort.on('message', onAssistantMessage);

            parentPort!.postMessage({ type: 'ready', worker: 'OracleWorker' });

            startWssReceptionist();

            // Phase 1: Stream ticks immediately (no hydration — test trade first)
            feed.start(onTick, (label, status) => {
                parentPort!.postMessage({ type: 'feed_status', label, status });
            });
            break;
        }

        // Phase 2: Main triggers hydration AFTER successful test trade
        case 'TRIGGER_HYDRATION': {
            feed.hydrateGap().then((payload) => {
                const hydMsg = { type: 'HYDRATION', payload };
                momPort?.postMessage(hydMsg);
                assistPort?.postMessage(hydMsg);

                for (const c of payload.cmeCandles) {
                    updateMacroRadar({ price: c.close, volume: c.volume, timestamp: c.timestamp, dataset: c.dataset, symbol: c.symbol } as any);
                }
                for (const c of payload.cfeCandles) {
                    updateMacroRadar({ price: c.close, volume: c.volume, timestamp: c.timestamp, dataset: c.dataset, symbol: c.symbol } as any);
                }

                parentPort!.postMessage({
                    type: 'HYDRATION_COMPLETE',
                    cmeCount: payload.cmeCandles.length,
                    cfeCount: payload.cfeCandles.length,
                    vixLevel: lastVixPrice,
                });
            }).catch((err: Error) => {
                console.error(`[M.o.M] Hydration failed: ${err.message}`);
                parentPort!.postMessage({ type: 'HYDRATION_COMPLETE', cmeCount: 0, cfeCount: 0, vixLevel: 0 });
            });
            break;
        }

        case 'VERIFY_FLAT_RESULT': {
            if ((msg.from as string) !== 'OracleWorker') break;

            const isFlat = msg.isFlat as boolean;
            const symbol = msg.symbol as string;

            if (isFlat) {
                console.log(
                    `[OracleWorker] ✅ Triple-Sweep COMPLETE — ${symbol} confirmed FLAT. ` +
                    `System reset to 🔭 Hunting Phase.`
                );
            } else {
                console.error(
                    `[OracleWorker] ❌ Triple-Sweep PHASE 3 FAILED — ${symbol} still shows open positions! ` +
                    `Escalating EMERGENCY_EXIT.`
                );
                // Escalate: blast emergency exit if broker still shows open positions
                momPort?.postMessage({ type: 'EMERGENCY_EXIT', reason: 'TRIPLE_SWEEP_PHASE3_DISCREPANCY' });
            }

            // Reset macro radar and broadcast SYSTEM_RESET to all peers
            defconLevel = 'GREEN';
            const resetMsg = { type: 'SYSTEM_RESET', ts: Date.now(), confirmedFlat: isFlat };
            momPort?.postMessage(resetMsg);
            assistPort?.postMessage(resetMsg);
            parentPort!.postMessage({ type: 'system_reset', symbol, ts: Date.now(), reason: lastSweepReason });
            break;
        }

        case 'subscribe': {
            break;
        }

        case 'shutdown': {
            console.log('[OracleWorker] Shutting down feed + WSS…');
            feed.disconnect();
            momPort?.close();
            assistPort?.close();
            process.exit(0);
            break;
        }

        default:
            console.warn(`[OracleWorker] Unknown message type: ${msg.type}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC: MomWorker → OracleWorker  (Handshake)
// ─────────────────────────────────────────────────────────────────────────────
function onMomMessage(data: { type: string; [key: string]: unknown }): void {
    switch (data.type) {

        /**
         * REQUEST_TAKEOFF — MomWorker is requesting clearance to enter a trade.
         * Oracle checks circuit breakers only (DefconLevel + VIX).
         * Directional bias is handled by the probability model (MTF + VWAP).
         */
        case 'REQUEST_TAKEOFF': {
            const cid       = data.correlationId as string;
            const symbol    = data.symbol as string;
            const direction = data.direction as string;

            const isVixElevated = lastVixPrice > 0 && lastVixPrice >= VIX_RED_THRESHOLD;

            let light: 'GREEN_LIGHT' | 'RED_LIGHT';
            let reason: string;

            if (defconLevel === 'RED') {
                light  = 'RED_LIGHT';
                reason = 'DefconLevel RED';
            } else if (isVixElevated) {
                light  = 'RED_LIGHT';
                reason = `VIX elevated (${lastVixPrice.toFixed(2)})`;
            } else {
                light  = 'GREEN_LIGHT';
                reason = `DefconLevel GREEN | VIX ${lastVixPrice.toFixed(2)}`;
            }

            parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                source:  'Oracle',
                regime:  'Oracle',
                message: `Handshake ${light} | ${symbol} ${direction} | ${reason}`,
            }});

            momPort?.postMessage({ type: light, correlationId: cid, reason });
            break;
        }

        default: break;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC: AssistantWorker → OracleWorker  (Triple-Sweep Phase 2)
// ─────────────────────────────────────────────────────────────────────────────
function onAssistantMessage(data: { type: string; [key: string]: unknown }): void {
    switch (data.type) {

        /**
         * SWEEP_PHASE_2_COMPLETE — AssistantWorker has confirmed 0 positions/orders.
         * Oracle performs the final verification and resets the system to Hunting Phase.
         */
        case 'SWEEP_PHASE_2_COMPLETE': {
            const payload = data.payload as { symbol: string; confirmed: boolean; ts: number };
            lastSweepReason = (data.payload as any).reason || 'UNKNOWN';
            console.log(`[OracleWorker] 🧹 Triple-Sweep PHASE 3 — Final flat verification for ${payload.symbol}…`);

            // Request a final position check from Main (Core 4) via parentPort
            parentPort!.postMessage({
                type:    'VERIFY_FLAT',
                phase:   3,
                symbol:  payload.symbol,
                from:    'OracleWorker',
            });

            // Note: VERIFY_FLAT_RESULT is handled in the parentPort listener below
            break;
        }

        default: break;
    }
}


