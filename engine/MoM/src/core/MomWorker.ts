/**
 * MomWorker.ts — Core 1
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • Receives ORB_SETUP signals from AssistantWorker.
 *   • HANDSHAKE: Sends REQUEST_TAKEOFF to OracleWorker before every entry.
 *     Only executes on GREEN_LIGHT — blocks on RED_LIGHT.
 *   • WILDERNESS RULES: If the ORB fires outside a Killzone, enforces the
 *     "Short Leash" — 50% SL, trail-to-BE on first profit, auto-scratch timer.
 *   • TRIPLE-SWEEP PHASE 1: On exit, cancels local orders and fires
 *     SWEEP_PHASE_1_COMPLETE to AssistantWorker to begin the exit consensus.
 *   • Broadcasts IN_TRADE / TRADE_CLOSED lifecycle to AssistantWorker.
 *   • Forwards EMERGENCY_EXIT and IMMINENT_REVERSION to broker via Main.
 *
 * IPC Ports:
 *   • oraclePort – MessagePort ↔ OracleWorker  (REQUEST_TAKEOFF / GREEN_LIGHT)
 *   • assistPort – MessagePort ↔ AssistantWorker (ORB_SETUP / IMMINENT_REVERSION)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parentPort, MessagePort } from 'worker_threads';
import { MarketClock }             from './MarketClock';
import { CandleAggregator, Candle, Tick } from '../market/CandleAggregator';
import { SMCExpert }               from '../experts/SMCExpert';
import { ContractBuilder }         from '../utils/ContractBuilder';
import { config }                  from '../config/env';

if (!parentPort) throw new Error('[MomWorker] Must be run as a worker thread.');

// ─── Peer ports ──────────────────────────────────────────────────────────────
let oraclePort: MessagePort | null = null;
let assistPort: MessagePort | null = null;

// ─── Engine state ────────────────────────────────────────────────────────────
type EngineState = 'IDLE' | 'AWAITING_HANDSHAKE' | 'IN_TRADE';
let engineState: EngineState = 'IDLE';
let isTestingTrade = false;

// ─── SMC Hunting (Core 1 signal engine) ──────────────────────────────────────
const smcExpert  = new SMCExpert();
const aggregator = new CandleAggregator(1, onCandleComplete);  // hoisted fn ref

// ─────────────────────────────────────────────────────────────────────────────
// WILDERNESS SHORT LEASH CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const SL_NORMAL_POINTS      = 20;         // standard stop-loss distance (pts)
const SL_WILDERNESS_PCT     = 0.50;       // cut SL by 50% in Wilderness
const BE_TRIGGER_POINTS     = 5;          // trail to BE once profit hits this many pts
const WILDERNESS_SCRATCH_MS = 3 * 60_000; // auto-scratch after 3 min if no displacement

// ─────────────────────────────────────────────────────────────────────────────
// ORACLE HANDSHAKE — REQUEST_TAKEOFF / GREEN_LIGHT
// ─────────────────────────────────────────────────────────────────────────────
const HANDSHAKE_TIMEOUT_MS = 3000;   // abort if Oracle doesn't respond in 3s

/** Pending handshake promise resolvers, keyed by correlation ID. */
const pendingHandshakes = new Map<string, (light: 'GREEN_LIGHT' | 'RED_LIGHT') => void>();

/**
 * Sends REQUEST_TAKEOFF to OracleWorker via the direct peer port.
 * Returns a Promise that resolves to 'GREEN_LIGHT' or 'RED_LIGHT'.
 * Times out to 'RED_LIGHT' after HANDSHAKE_TIMEOUT_MS.
 */
function requestTakeoff(symbol: string, direction: string): Promise<'GREEN_LIGHT' | 'RED_LIGHT'> {
    return new Promise((resolve) => {
        const correlationId = `${symbol}-${Date.now()}`;

        // Register the resolver — will be called when Oracle responds
        pendingHandshakes.set(correlationId, resolve);

        // Safety timeout: treat no-response as RED_LIGHT
        const timer = setTimeout(() => {
            if (pendingHandshakes.has(correlationId)) {
                pendingHandshakes.delete(correlationId);
                console.warn(`[MomWorker] ⏱ Handshake timeout for ${symbol} ${direction} — treating as RED_LIGHT.`);
                resolve('RED_LIGHT');
            }
        }, HANDSHAKE_TIMEOUT_MS);

        oraclePort?.postMessage({
            type:          'REQUEST_TAKEOFF',
            correlationId,
            symbol,
            direction,
            ts:            Date.now(),
        });

        // Keep timer ref alive (Node GC safety)
        void timer;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVE TRADE STATE (for Wilderness Short Leash management)
// ─────────────────────────────────────────────────────────────────────────────
interface ActiveTradeContext {
    symbol:        string;
    direction:     'LONG' | 'SHORT';
    entryPrice:    number;
    stopPrice:     number;
    entryTs:       number;
    isWilderness:  boolean;
    scratchTimer?: ReturnType<typeof setTimeout>;
    beTriggered:   boolean;
}

let activeTrade: ActiveTradeContext | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// TRIPLE-SWEEP — Phase 1
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Called when MoM closes a trade (stop hit, target hit, IMMINENT_REVERSION, etc.).
 * Phase 1: Cancel local orders → notify AssistantWorker to begin the exit consensus.
 */
function initiateTripleSweepPhase1(reason: string): void {
    if (!activeTrade) return;

    const trade = activeTrade;
    console.log(`[MomWorker] 🧹 Triple-Sweep PHASE 1 initiated | Reason: ${reason}`);

    // Cancel Wilderness scratch timer if running
    if (trade.scratchTimer) clearTimeout(trade.scratchTimer);

    // Tell Main to cancel all working orders for this symbol
    parentPort!.postMessage({
        type:    'trade_command',
        payload: { action: 'CANCEL_ALL_ORDERS', symbol: trade.symbol, reason },
    });

    // Notify AssistantWorker → begins Phase 2 verification
    assistPort?.postMessage({
        type:    'SWEEP_PHASE_1_COMPLETE',
        payload: {
            symbol:    trade.symbol,
            direction: trade.direction,
            reason,
            ts:        Date.now(),
        },
    });

    // Broadcast trade closed lifecycle event
    assistPort?.postMessage({
        type:    'TRADE_CLOSED',
        payload: { symbol: trade.symbol, reason, ts: Date.now() },
    });

    engineState = 'IDLE';
    activeTrade = null;

    parentPort!.postMessage({ type: 'trade_closed', payload: { symbol: trade.symbol, reason } });
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC: OracleWorker → MomWorker
// ─────────────────────────────────────────────────────────────────────────────
function onOracleMessage(data: { type: string; [key: string]: unknown }): void {
    switch (data.type) {

        // ── Handshake response ────────────────────────────────────────────────
        case 'GREEN_LIGHT':
        case 'RED_LIGHT': {
            const cid = data.correlationId as string;
            const resolver = pendingHandshakes.get(cid);
            if (resolver) {
                pendingHandshakes.delete(cid);
                resolver(data.type as 'GREEN_LIGHT' | 'RED_LIGHT');
            }
            break;
        }

        // ── Live tick processing ───────────────────────────────────────────────
        case 'tick': {
            const tick = data.payload as Tick;

            if (isTestingTrade && engineState === 'IDLE') {
                isTestingTrade = false;
                engineState = 'IN_TRADE';
                const tradeSymbol = ContractBuilder.getActiveContract(config.INDICES);

                activeTrade = { symbol: tradeSymbol, direction: 'LONG', entryPrice: (tick as any).price, stopPrice: (tick as any).price - 100, entryTs: (tick as any).timestamp, isWilderness: false, beTriggered: false };

                parentPort!.postMessage({ type: 'trade_command', payload: { action: 'TEST_ENTER', symbol: tradeSymbol, price: (tick as any).price } });

                setTimeout(() => {
                    parentPort!.postMessage({ type: 'trade_command', payload: { action: 'FLATTEN_ALL', symbol: tradeSymbol, reason: 'TEST_TRADE_COMPLETE' } });
                    initiateTripleSweepPhase1('TEST_TRADE_COMPLETE');
                }, 15000);
            }

            // Always feed aggregator so SMC indicators stay aligned
            aggregator.processTick(tick);

            // Short Leash: trail to BE monitoring (Wilderness trades only)
            if (activeTrade && activeTrade.isWilderness && !activeTrade.beTriggered) {
                const profit = activeTrade.direction === 'LONG'
                    ? tick.price - activeTrade.entryPrice
                    : activeTrade.entryPrice - tick.price;

                if (profit >= BE_TRIGGER_POINTS) {
                    activeTrade.beTriggered = true;
                    activeTrade.stopPrice   = activeTrade.entryPrice;
                    console.log(`[MomWorker] 🏔️  Short Leash: Trailing stop → BE @ ${activeTrade.entryPrice} (${activeTrade.symbol})`);
                    parentPort!.postMessage({
                        type:    'trade_command',
                        payload: { action: 'MOVE_STOP_TO_BE', symbol: activeTrade.symbol, stopPrice: activeTrade.entryPrice },
                    });
                }
            }
            break;
        }

        // ── Emergency exit ────────────────────────────────────────────────────
        case 'EMERGENCY_EXIT': {
            console.error('[MomWorker] 🚨 EMERGENCY_EXIT — flattening all positions!');
            parentPort!.postMessage({ type: 'trade_command', payload: { action: 'FLATTEN_ALL', reason: data.reason } });
            initiateTripleSweepPhase1('EMERGENCY_EXIT');
            break;
        }

        case 'defcon_change': {
            if ((data.level as string) === 'RED') {
                console.warn('[MomWorker] DefconLevel RED — halting new entries.');
            }
            break;
        }

        default: break;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC: AssistantWorker → MomWorker
// ─────────────────────────────────────────────────────────────────────────────
async function onAssistantMessage(data: { type: string; [key: string]: unknown }): Promise<void> {
    switch (data.type) {

        /**
         * ORB_SETUP — Volume-anomaly breakout confirmed by AssistantWorker.
         * Gate sequence: IDLE check → Wilderness check → HANDSHAKE → execute.
         */
        case 'ORB_SETUP': {
            const setup = data.payload as {
                symbol: string; direction: 'LONG' | 'SHORT';
                breakoutPrice: number; volumeRatio: number;
                boxHigh: number; boxLow: number; ts: number;
            };

            if (engineState !== 'IDLE') {
                console.log(`[MomWorker] ORB_SETUP ignored — engine is ${engineState}.`);
                return;
            }

            const inWilderness = MarketClock.isWilderness(setup.ts);
            const zoneLabel    = inWilderness ? '🌲 WILDERNESS' : '🎯 KILLZONE';
            console.log(
                `[MomWorker] 📡 ORB_SETUP | ${setup.symbol} ${setup.direction} | ` +
                `Vol: ${setup.volumeRatio.toFixed(2)}× | Zone: ${zoneLabel}`
            );

            // ── ORACLE HANDSHAKE ──────────────────────────────────────────────
            engineState = 'AWAITING_HANDSHAKE';
            const light = await requestTakeoff(setup.symbol, setup.direction);

            if (light === 'RED_LIGHT') {
                parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                    source:  'MoM',
                    regime:  inWilderness ? 'Wilderness' : 'Killzone',
                    message: `RED_LIGHT: Oracle blocked ${setup.symbol} ${setup.direction} ORB entry. Engine reset to IDLE.`,
                }});
                engineState = 'IDLE';
                return;
            }

            console.log(`[MomWorker] 🟢 GREEN_LIGHT from Oracle — proceeding with ${setup.symbol} ${setup.direction}.`);

            // ── WILDERNESS SHORT LEASH ────────────────────────────────────────
            let slDistance = SL_NORMAL_POINTS;
            if (inWilderness) {
                slDistance = Math.ceil(SL_NORMAL_POINTS * SL_WILDERNESS_PCT);
                parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                    source:  'MoM',
                    regime:  'Wilderness',
                    message: `Short Leash activated for ${setup.symbol} ${setup.direction}: SL → ${slDistance} pts. Auto-scratch in ${WILDERNESS_SCRATCH_MS / 60000} min.`,
                }});
            }

            const stopPrice = setup.direction === 'LONG'
                ? setup.breakoutPrice - slDistance
                : setup.breakoutPrice + slDistance;

            // ── ENTER TRADE ───────────────────────────────────────────────────
            engineState = 'IN_TRADE';

            // Build and store trade context
            activeTrade = {
                symbol:       setup.symbol,
                direction:    setup.direction,
                entryPrice:   setup.breakoutPrice,
                stopPrice,
                entryTs:      setup.ts,
                isWilderness: inWilderness,
                beTriggered:  false,
            };

            // Wilderness: set auto-scratch timer
            if (inWilderness) {
                activeTrade.scratchTimer = setTimeout(() => {
                    if (activeTrade && !activeTrade.beTriggered) {
                        console.warn(`[MomWorker] 🌲 Wilderness scratch — no displacement after ${WILDERNESS_SCRATCH_MS / 60000} min. Exiting.`);
                        parentPort!.postMessage({
                            type:    'trade_command',
                            payload: { action: 'FLATTEN_ALL', symbol: activeTrade.symbol, reason: 'WILDERNESS_NO_DISPLACEMENT' },
                        });
                        initiateTripleSweepPhase1('WILDERNESS_NO_DISPLACEMENT');
                    }
                }, WILDERNESS_SCRATCH_MS);
            }

            // Notify AssistantWorker → activates Tactical Overwatch
            assistPort?.postMessage({
                type:    'IN_TRADE',
                payload: {
                    symbol:     setup.symbol,
                    direction:  setup.direction,
                    entryPrice: setup.breakoutPrice,
                    entryTs:    setup.ts,
                    stopPrice,
                },
            });

            // Forward to Main → Broker
            parentPort!.postMessage({
                type:    'trade_command',
                payload: {
                    action:      'ENTER',
                    symbol:      setup.symbol,
                    direction:   setup.direction,
                    price:       setup.breakoutPrice,
                    stopPrice,
                    isWilderness: inWilderness,
                },
            });
            break;
        }

        /**
         * IMMINENT_REVERSION — Toxic opposing flow detected by Tactical Overwatch.
         */
        case 'IMMINENT_REVERSION': {
            const warn = data.payload as { symbol: string; volumeRatio: number; priceDeltaPct: number };
            console.warn(
                `[MomWorker] ⚠️  IMMINENT_REVERSION | ${warn.symbol} | ` +
                `Vol: ${warn.volumeRatio.toFixed(2)}× | Δ: ${warn.priceDeltaPct.toFixed(3)}%`
            );
            parentPort!.postMessage({
                type:    'trade_command',
                payload: { action: 'TIGHTEN_STOP', reason: 'IMMINENT_REVERSION', ...warn },
            });
            break;
        }

        case 'DEFCON_RED': {
            console.warn('[MomWorker] DEFCON_RED from AssistantWorker — blocking new entries.');
            break;
        }

        default: break;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main IPC handler (from Core 4)
// ─────────────────────────────────────────────────────────────────────────────
parentPort.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {

        case 'init': {
            oraclePort = msg.oraclePort as MessagePort;
            assistPort = msg.assistPort as MessagePort;

            oraclePort.on('message', onOracleMessage);
            assistPort.on('message', (m) => void onAssistantMessage(m));

            parentPort!.postMessage({ type: 'ready', worker: 'MomWorker' });
            console.log('[MomWorker] Core 1 online — Handshake + Wilderness + Triple-Sweep wired.');
            break;
        }

        /**
         * position_closed — sent by Main after broker confirms exit.
         * Triggers Phase 1 of the Triple-Sweep.
         */
        case 'position_closed': {
            initiateTripleSweepPhase1(msg.reason as string ?? 'BROKER_CONFIRMED_EXIT');
            break;
        }

        /**
         * hydration_payload — sent by Core 4 before live feeds start.
         * Warms smcExpert's rolling windows and primes the aggregator state
         * so the engine can trade immediately on the first live candle.
         */
        case 'hydration_payload':
        case 'HYDRATION': {
            const p = msg.payload as any;
            const cmeCandles = p.cmeCandles || [];
            for (const c of cmeCandles) {
                // 1. Warm SMC expert internal rolling windows
                smcExpert.analyze({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, timestamp: c.timestamp });

                // 2. Feed a synthetic close tick to the aggregator to align its 1-min state
                aggregator.processTick({ price: c.close, volume: c.volume, timestamp: c.timestamp + 59_000 });
            }

            if (cmeCandles.length < 15) {
                isTestingTrade = true;
                console.log('[MomWorker] 🧊 Cold boot detected. Arming Test Trade...');
            }

            console.log(`[MomWorker] 💧 Hydrated: ${cmeCandles.length} CME candles — SMC expert + aggregator primed.`);
            break;
        }

        case 'shutdown': {
            console.log('[MomWorker] Shutting down…');
            if (activeTrade?.scratchTimer) clearTimeout(activeTrade.scratchTimer);
            oraclePort?.close();
            assistPort?.close();
            process.exit(0);
        }

        default:
            console.warn(`[MomWorker] Unknown message type: ${msg.type}`);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Public helper — called by Phase 4 execution engine
// ─────────────────────────────────────────────────────────────────────────────
export function notifyTradeClosed(symbol: string, pnl: number): void {
    initiateTripleSweepPhase1(`CLOSED_PNL_${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// SMC SIGNAL PIPELINE — onCandleComplete → processSmcSignal
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Sync callback registered with CandleAggregator.
 * Delegates to async processSmcSignal and catches unhandled rejections.
 * Function declaration ensures hoisting (safe for aggregator constructor reference above).
 */
function onCandleComplete(candle: Candle): void {
    processSmcSignal(candle).catch((err: Error) =>
        console.error('[MomWorker] SMC pipeline error:', err.message)
    );
}

/**
 * Full SMC signal evaluation + Handshake + Wilderness gate + entry dispatch.
 * Mirrors the ORB_SETUP flow so both signal sources share the same execution path.
 */
async function processSmcSignal(candle: Candle): Promise<void> {
    const signal = smcExpert.analyze(candle);
    if (signal === 'HOLD') return;
    if (engineState !== 'IDLE')  return;

    const direction: 'LONG' | 'SHORT' = signal === 'BUY' ? 'LONG' : 'SHORT';
    const tradeSymbol = ContractBuilder.getActiveContract(config.INDICES);
    const inWilderness = MarketClock.isWilderness(candle.timestamp);
    const zoneLabel    = inWilderness ? '🌲 WILDERNESS' : '🎯 KILLZONE';

    console.log(
        `[MomWorker] 📊 SMC Signal | ${tradeSymbol} ${direction} | ` +
        `Zone: ${zoneLabel} | C: ${candle.close}`
    );

    // ── ORACLE HANDSHAKE ──────────────────────────────────────────────────────
    engineState = 'AWAITING_HANDSHAKE';
    const light = await requestTakeoff(tradeSymbol, direction);

    if (light === 'RED_LIGHT') {
        parentPort!.postMessage({ type: 'TELEMETRY', payload: {
            source:  'MoM',
            regime:  inWilderness ? 'Wilderness' : 'Killzone',
            message: `RED_LIGHT: Oracle blocked ${tradeSymbol} ${direction} SMC entry. Engine reset to IDLE.`,
        }});
        engineState = 'IDLE';
        return;
    }

    console.log(`[MomWorker] 🟢 GREEN_LIGHT — executing ${tradeSymbol} ${direction}.`);

    // ── WILDERNESS SHORT LEASH ────────────────────────────────────────────────
    let slDistance = SL_NORMAL_POINTS;
    if (inWilderness) {
        slDistance = Math.ceil(SL_NORMAL_POINTS * SL_WILDERNESS_PCT);
        parentPort!.postMessage({ type: 'TELEMETRY', payload: {
            source:  'MoM',
            regime:  'Wilderness',
            message: `SMC Short Leash activated for ${tradeSymbol} ${direction}: SL → ${slDistance} pts.`,
        }});
    }

    const stopPrice = direction === 'LONG'
        ? candle.close - slDistance
        : candle.close + slDistance;

    // ── ENTER TRADE ───────────────────────────────────────────────────────────
    engineState = 'IN_TRADE';

    activeTrade = {
        symbol:       tradeSymbol,
        direction,
        entryPrice:   candle.close,
        stopPrice,
        entryTs:      candle.timestamp,
        isWilderness: inWilderness,
        beTriggered:  false,
    };

    if (inWilderness) {
        activeTrade.scratchTimer = setTimeout(() => {
            if (activeTrade && !activeTrade.beTriggered) {
                console.warn('[MomWorker] 🌲 SMC Wilderness scratch — no displacement.');
                parentPort!.postMessage({
                    type:    'trade_command',
                    payload: { action: 'FLATTEN_ALL', symbol: activeTrade.symbol, reason: 'WILDERNESS_NO_DISPLACEMENT' },
                });
                initiateTripleSweepPhase1('WILDERNESS_NO_DISPLACEMENT');
            }
        }, WILDERNESS_SCRATCH_MS);
    }

    // Notify AssistantWorker → activate Tactical Overwatch
    assistPort?.postMessage({
        type:    'IN_TRADE',
        payload: { symbol: tradeSymbol, direction, entryPrice: candle.close, entryTs: candle.timestamp, stopPrice },
    });

    // Forward to Main (Core 4) → Broker
    parentPort!.postMessage({
        type:    'trade_command',
        payload: {
            action:      'ENTER',
            symbol:      tradeSymbol,
            direction,
            price:       candle.close,
            stopPrice,
            isWilderness: inWilderness,
            source:      'SMC',
        },
    });
}
