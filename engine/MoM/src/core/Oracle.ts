/**
 * Oracle.ts — Core 3
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • Owns the DatabentoLiveService — SOLE source of CME + CFE market data.
 *   • Multicasts every tick to MomWorker (momPort), AssistantWorker (assistPort),
 *     and Main/Core 4 (parentPort) with zero latency.
 *   • Runs the Macro Radar: VWAP-slope micro-trend bias + VIX spike tracking.
 *   • Maintains a DefconLevel (GREEN | RED) broadcast to all peers.
 *   • Economic Calendar: Fetches today's US events from FMP at boot,
 *     computes asymmetric blackout windows, and blocks REQUEST_TAKEOFF
 *     during high/medium-impact news releases.
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
import { config } from '../config/env';
import axios from 'axios';
import cron from 'node-cron';

if (!parentPort) throw new Error('[Oracle] Must be run as a worker thread.');

// ─── Constants ────────────────────────────────────────────────────────────────
const WSS_PORT          = 8080;
const VIX_RED_THRESHOLD = 25.0;      // VIX level that triggers DefconLevel RED
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

// ─────────────────────────────────────────────────────────────────────────────
// ECONOMIC CALENDAR — FMP Integration
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Asymmetric blockout rules (ICT-style).
 * Shorter window BEFORE (calm period), longer AFTER (Judas Swing + recovery).
 * Values are in minutes. Matched by keyword against event description.
 */
interface BlockoutRule {
    beforeMin: number;   // minutes before event to block
    afterMin:  number;   // minutes after event to block
}

const BLOCKOUT_RULES: Record<string, BlockoutRule> = {
    // Tier 1: Nuclear — FOMC events
    'fomc':            { beforeMin: 30, afterMin: 60 },
    'federal reserve': { beforeMin: 30, afterMin: 60 },
    'fed chair':       { beforeMin: 15, afterMin: 30 },
    'fed speak':       { beforeMin: 15, afterMin: 30 },
    'fomc minutes':    { beforeMin: 10, afterMin: 30 },

    // Tier 2: Red Folder — major macro data
    'nonfarm':         { beforeMin: 10, afterMin: 15 },
    'non-farm':        { beforeMin: 10, afterMin: 15 },
    'payrolls':        { beforeMin: 10, afterMin: 15 },
    'cpi':             { beforeMin: 10, afterMin: 15 },
    'ppi':             { beforeMin: 10, afterMin: 15 },
    'gdp':             { beforeMin: 10, afterMin: 15 },
    'retail sales':    { beforeMin: 10, afterMin: 15 },

    // Tier 3: Medium Impact — secondary data
    'jobless':         { beforeMin: 5, afterMin: 10 },
    'ism':             { beforeMin: 5, afterMin: 10 },
    'pmi':             { beforeMin: 5, afterMin: 10 },
    'consumer confidence': { beforeMin: 5, afterMin: 10 },
    'housing':         { beforeMin: 5, afterMin: 10 },
    'durable goods':   { beforeMin: 5, afterMin: 10 },
};

const DEFAULT_BLOCKOUT: BlockoutRule = { beforeMin: 5, afterMin: 10 };

interface CachedNewsEvent {
    timestampMs:   number;     // event release time (UTC ms)
    description:   string;     // e.g. "Non-Farm Payrolls"
    impact:        string;     // "High" | "Medium" | "Low"
    blackoutStart: number;     // ms — when blackout begins
    blackoutEnd:   number;     // ms — when blackout lifts
}

let cachedEvents: CachedNewsEvent[] = [];

/** Match event description against blockout rules, return the appropriate rule. */
function getBlockoutRule(eventDescription: string): BlockoutRule {
    const lower = eventDescription.toLowerCase();
    for (const [keyword, rule] of Object.entries(BLOCKOUT_RULES)) {
        if (lower.includes(keyword)) return rule;
    }
    return DEFAULT_BLOCKOUT;
}

/** Fetch today's economic events from FMP and build blockout windows. */
async function fetchTodaysCalendar(): Promise<void> {
    const apiKey = config.ORACLE_API_KEY;
    if (!apiKey) {
        console.log('[Oracle] 📅 No ORACLE_API_KEY — calendar disabled.');
        return;
    }

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    try {
        console.log(`[Oracle] 📅 Fetching economic calendar for ${dateStr}...`);

        const url = `https://financialmodelingprep.com/stable/economic-calendar?from=${dateStr}&to=${dateStr}&apikey=${apiKey}`;
        const response = await axios.get(url, { timeout: 10000 });
        const events: any[] = response.data || [];

        // Filter: US-only + HIGH or MEDIUM impact
        const relevantEvents = events.filter((e: any) => {
            const isUS = e.country === 'US' || e.currency === 'USD';
            const impact = (e.impact || '').toLowerCase();
            return isUS && (impact === 'high' || impact === 'medium');
        });

        // Build cached events with asymmetric blackout windows
        cachedEvents = relevantEvents
            .map((e: any) => {
                const ts = new Date(e.date).getTime();
                if (isNaN(ts)) return null;

                const rule = getBlockoutRule(e.event || '');
                return {
                    timestampMs:   ts,
                    description:   e.event || 'Unknown',
                    impact:        e.impact || 'Unknown',
                    blackoutStart: ts - (rule.beforeMin * 60_000),
                    blackoutEnd:   ts + (rule.afterMin * 60_000),
                };
            })
            .filter((e): e is CachedNewsEvent => e !== null)
            .sort((a, b) => a.timestampMs - b.timestampMs);

        // Log events
        if (cachedEvents.length > 0) {
            console.log(`[Oracle] 📅 ${cachedEvents.length} event(s) today:`);
            for (const ev of cachedEvents) {
                const etTime = new Date(ev.timestampMs).toLocaleTimeString('en-US', {
                    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
                });
                const startET = new Date(ev.blackoutStart).toLocaleTimeString('en-US', {
                    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
                });
                const endET = new Date(ev.blackoutEnd).toLocaleTimeString('en-US', {
                    timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
                });
                const icon = ev.impact.toLowerCase() === 'high' ? '🔴' : '🟡';
                console.log(`  ${icon} ${etTime} ET — ${ev.description} (${ev.impact}) — Blackout: ${startET}-${endET} ET`);
            }
        } else {
            console.log('[Oracle] 📅 No high/medium-impact US events today. Clear skies. ✅');
        }

    } catch (error: any) {
        console.warn(`[Oracle] ⚠️ Calendar fetch failed: ${error.message}. Trading unrestricted.`);
    }
}

/** Check if any news blackout is currently active. Returns the event name or null. */
function getActiveBlackout(): string | null {
    const now = Date.now();
    for (const ev of cachedEvents) {
        if (now >= ev.blackoutStart && now <= ev.blackoutEnd) {
            const minutesUntilClear = Math.ceil((ev.blackoutEnd - now) / 60_000);
            return `${ev.description} (clears in ${minutesUntilClear}min)`;
        }
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Macro Radar
// ─────────────────────────────────────────────────────────────────────────────

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
    console.log(`🚨 [Oracle] DefconLevel → ${level} | Reason: ${reason}`);
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
        console.log(`🛰️  [Oracle] WSS Receptionist listening on ws://localhost:${WSS_PORT}`);
    });

    wss.on('connection', (ws: WebSocket, req) => {
        const clientIp = req.socket.remoteAddress ?? 'unknown';
        console.log(`🔗 [Oracle] NOVA connected from ${clientIp}`);

        // Send current state on connect
        ws.send(JSON.stringify({ type: 'oracle_hello', defcon: defconLevel, vixLevel: lastVixPrice }));

        ws.on('message', (raw) => {
            const cmd = raw.toString().trim().toUpperCase();
            console.log(`📨 [Oracle] NOVA command received: ${cmd}`);

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
                    console.error('🚨 [Oracle] PULL_PLUG — blasting EMERGENCY_EXIT to MomWorker!');
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
                    const blackout = getActiveBlackout();
                    ws.send(JSON.stringify({
                        type:      'status',
                        defcon:    defconLevel,
                        vixLevel:  lastVixPrice,
                        vwapSlope,
                        newsBlackout: blackout,
                        ts:        Date.now(),
                    }));
                    break;
                }

                default:
                    ws.send(JSON.stringify({ type: 'error', msg: `Unknown command: ${cmd}` }));
            }
        });

        ws.on('close', () => console.log(`🔌 [Oracle] NOVA client disconnected from ${clientIp}`));
        ws.on('error', (err) => console.error(`❌ [Oracle] WSS client error: ${err.message}`));
    });

    wss.on('error', (err) => {
        console.error(`❌ [Oracle] WSS error: ${err.message}`);
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

            parentPort!.postMessage({ type: 'ready', worker: 'Oracle' });

            startWssReceptionist();

            // Fetch economic calendar (non-blocking — don't delay boot)
            fetchTodaysCalendar().catch((err) =>
                console.warn(`[Oracle] Calendar preflight failed: ${err.message}`)
            );

            // Schedule daily refresh at 08:00 ET (before AM killzone)
            cron.schedule('0 8 * * *', () => {
                console.log('[Oracle] 📅 Daily calendar refresh (08:00 ET)...');
                fetchTodaysCalendar().catch(() => {});
            }, { timezone: 'America/New_York' });

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
            if ((msg.from as string) !== 'Oracle') break;

            const isFlat = msg.isFlat as boolean;
            const symbol = msg.symbol as string;

            if (isFlat) {
                console.log(
                    `[Oracle] ✅ Triple-Sweep COMPLETE — ${symbol} confirmed FLAT. ` +
                    `System reset to 🔭 Hunting Phase.`
                );
            } else {
                console.error(
                    `[Oracle] ❌ Triple-Sweep PHASE 3 FAILED — ${symbol} still shows open positions! ` +
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
            console.log('[Oracle] Shutting down feed + WSS…');
            feed.disconnect();
            momPort?.close();
            assistPort?.close();
            process.exit(0);
            break;
        }

        default:
            console.warn(`[Oracle] Unknown message type: ${msg.type}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// IPC: MomWorker → Oracle  (Handshake)
// ─────────────────────────────────────────────────────────────────────────────
function onMomMessage(data: { type: string; [key: string]: unknown }): void {
    switch (data.type) {

        /**
         * REQUEST_TAKEOFF — MomWorker is requesting clearance to enter a trade.
         * Oracle checks 3 circuit breakers:
         *   Gate 1: DefconLevel RED       → RED_LIGHT
         *   Gate 2: VIX elevated          → RED_LIGHT
         *   Gate 3: News blackout active  → RED_LIGHT
         * Directional bias is handled by the probability model (MTF + VWAP).
         */
        case 'REQUEST_TAKEOFF': {
            const cid       = data.correlationId as string;
            const symbol    = data.symbol as string;
            const direction = data.direction as string;

            const isVixElevated = lastVixPrice > 0 && lastVixPrice >= VIX_RED_THRESHOLD;
            const blackoutEvent = getActiveBlackout();

            let light: 'GREEN_LIGHT' | 'RED_LIGHT';
            let reason: string;

            if (defconLevel === 'RED') {
                light  = 'RED_LIGHT';
                reason = 'DefconLevel RED';
            } else if (isVixElevated) {
                light  = 'RED_LIGHT';
                reason = `VIX elevated (${lastVixPrice.toFixed(2)})`;
            } else if (blackoutEvent) {
                light  = 'RED_LIGHT';
                reason = `NEWS_BLACKOUT: ${blackoutEvent}`;
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
// IPC: AssistantWorker → Oracle  (Triple-Sweep Phase 2)
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
            console.log(`[Oracle] 🧹 Triple-Sweep PHASE 3 — Final flat verification for ${payload.symbol}…`);

            // Request a final position check from Main (Core 4) via parentPort
            parentPort!.postMessage({
                type:    'VERIFY_FLAT',
                phase:   3,
                symbol:  payload.symbol,
                from:    'Oracle',
            });

            // Note: VERIFY_FLAT_RESULT is handled in the parentPort listener above
            break;
        }

        default: break;
    }
}
