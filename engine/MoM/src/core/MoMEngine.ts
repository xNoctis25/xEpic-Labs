/**
 * MoMEngine.ts — Core 1 (M.o.M Signal Engine)
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
import { SMC, SmcSignal }    from '../experts/SMC';
import { ContractBuilder }         from '../utils/ContractBuilder';
import { config }                  from '../config/env';

if (!parentPort) throw new Error('[MoMEngine] Must be run as a worker thread.');

// ─── Peer ports ──────────────────────────────────────────────────────────────
let oraclePort: MessagePort | null = null;
let assistPort: MessagePort | null = null;

// ─── Engine state ────────────────────────────────────────────────────────────
type EngineState = 'IDLE' | 'AWAITING_HANDSHAKE' | 'IN_TRADE';
let engineState: EngineState = 'IDLE';
let isTestingTrade = true;  // Armed immediately — test trade fires on first tick (before hydration)
let isHuntingActive = false; // Warmup gate: blocks ALL trade signals until hydration completes

// ─── SMC Hunting (Core 1 signal engine) ──────────────────────────────────────
const smcExpert  = new SMC();
const aggregator = new CandleAggregator(1, onCandleComplete);  // hoisted fn ref

// ─────────────────────────────────────────────────────────────────────────────
// WILDERNESS SHORT LEASH CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────
const SL_NORMAL_POINTS      = 20;         // standard stop-loss distance (pts)
const SL_WILDERNESS_PCT     = 0.50;       // cut SL by 50% in Wilderness
const BE_TRIGGER_POINTS     = 5;          // trail to BE once profit hits this many pts
const WILDERNESS_SCRATCH_MS = 3 * 60_000; // auto-scratch after 3 min if no displacement
const MIN_SMC_CONFIDENCE    = 5;          // minimum confluence score (out of 8) to take a trade

// DEFCON state (received from OracleWorker)
let isDefconRed = false;

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
                console.warn(`[MoMEngine] ⏱ Handshake timeout for ${symbol} ${direction} — treating as RED_LIGHT.`);
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
// ACTIVE TRADE STATE + MONITORING
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
    // ── ATM Monitoring State ──
    candlesSinceEntry: number;
    volumeHistory:     number[];
    candleHighHistory: number[];
    candleLowHistory:  number[];
    isChokeActive:     boolean;
}

let activeTrade: ActiveTradeContext | null = null;

// ─── ATM Constants ───────────────────────────────────────────────────────────
const TIME_DECAY_CANDLES      = 5;      // scratch after N candles with no momentum
const FLAT_TOLERANCE_POINTS   = 0.50;   // ≈ 2 ticks on MES
const VOLUME_DECLINE_COUNT    = 3;      // consecutive declining volume candles
const CHOKE_DISTANCE_POINTS   = 3;      // tight stop distance during choke hold

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVE TRADE MONITOR — Embedded Systems 2, 3, 4
// Runs per-candle when IN_TRADE. Uses IPC trade_commands (no broker access).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-candle monitoring of the active position.
 * Priority: EOD → Structural Invalidation → Time Decay → Exhaustion/Choke
 */
function monitorActiveTrade(candle: Candle, signal: SmcSignal): void {
    if (!activeTrade || engineState !== 'IN_TRADE') return;

    const trade = activeTrade;
    trade.candlesSinceEntry++;
    trade.volumeHistory.push(candle.volume);
    trade.candleHighHistory.push(candle.high);
    trade.candleLowHistory.push(candle.low);

    const profitPoints = trade.direction === 'LONG'
        ? candle.close - trade.entryPrice
        : trade.entryPrice - candle.close;

    // ── System 2: Structural Invalidation ────────────────────────────────
    if (signal.action !== 'HOLD') {
        const isOpposing = (trade.direction === 'LONG' && signal.action === 'SELL')
                        || (trade.direction === 'SHORT' && signal.action === 'BUY');
        if (isOpposing) {
            console.log(`[MoMEngine] 🔄 STRUCTURAL INVALIDATION: ${trade.direction} vs confirmed ${signal.action}`);
            parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                source: 'MoM', regime: trade.isWilderness ? 'Wilderness' : 'Killzone',
                message: `CHOKED: ${trade.symbol} structural invalidation. ${trade.direction} vs ${signal.action}. PnL: ${profitPoints.toFixed(1)}pts`
            }});
            parentPort!.postMessage({
                type: 'trade_command',
                payload: { action: 'FLATTEN_ALL', symbol: trade.symbol, reason: 'STRUCTURAL_INVALIDATION' },
            });
            initiateTripleSweepPhase1('STRUCTURAL_INVALIDATION');
            return;
        }
    }

    // ── System 3a: Time Decay ────────────────────────────────────────────
    if (trade.candlesSinceEntry > TIME_DECAY_CANDLES && profitPoints <= FLAT_TOLERANCE_POINTS) {
        console.log(`[MoMEngine] ⏰ TIME DECAY: ${trade.candlesSinceEntry} candles, PnL: ${profitPoints.toFixed(2)}pts — momentum dead.`);
        parentPort!.postMessage({ type: 'TELEMETRY', payload: {
            source: 'MoM', regime: trade.isWilderness ? 'Wilderness' : 'Killzone',
            message: `CHOKED: ${trade.symbol} time decay. ${trade.candlesSinceEntry} candles, PnL: ${profitPoints.toFixed(2)}pts`
        }});
        parentPort!.postMessage({
            type: 'trade_command',
            payload: { action: 'FLATTEN_ALL', symbol: trade.symbol, reason: 'TIME_DECAY' },
        });
        initiateTripleSweepPhase1('TIME_DECAY');
        return;
    }

    // ── System 3b: Momentum Exhaustion (volume decline + price stall) ────
    const decliningVol = checkVolumeDecline(trade);
    const priceStalled = checkPriceStalled(trade);

    if (decliningVol && priceStalled) {
        console.log(`[MoMEngine] 📉 EXHAUSTION: Declining volume + price stalled.`);

        if (profitPoints <= 0) {
            // Losing + exhausted → exit
            parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                source: 'MoM', regime: trade.isWilderness ? 'Wilderness' : 'Killzone',
                message: `CHOKED: ${trade.symbol} exhaustion (negative PnL: ${profitPoints.toFixed(1)}pts). Flattening.`
            }});
            parentPort!.postMessage({
                type: 'trade_command',
                payload: { action: 'FLATTEN_ALL', symbol: trade.symbol, reason: 'EXHAUSTION_NEGATIVE_PNL' },
            });
            initiateTripleSweepPhase1('EXHAUSTION_NEGATIVE_PNL');
            return;
        }

        // ── System 4: Choke Hold (in profit + exhausted) ─────────────────
        engageChokeHold(trade, candle.close, profitPoints);
    }
}

/** System 3b helper: 3 consecutive declining volume candles. */
function checkVolumeDecline(trade: ActiveTradeContext): boolean {
    const h = trade.volumeHistory;
    if (h.length < VOLUME_DECLINE_COUNT) return false;
    for (let i = h.length - VOLUME_DECLINE_COUNT + 1; i < h.length; i++) {
        if (h[i] >= h[i - 1]) return false;
    }
    const recent = h.slice(-VOLUME_DECLINE_COUNT).map(v => Math.round(v));
    console.log(`[MoMEngine] 📉 Volume declining: [${recent.join(' → ')}]`);
    return true;
}

/** System 3b helper: price stopped making new highs (LONG) or lows (SHORT). */
function checkPriceStalled(trade: ActiveTradeContext): boolean {
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

/** System 4: Tightens stop to CHOKE_DISTANCE_POINTS behind market. */
function engageChokeHold(trade: ActiveTradeContext, currentPrice: number, profitPoints: number): void {
    let tightStop = trade.direction === 'LONG'
        ? currentPrice - CHOKE_DISTANCE_POINTS
        : currentPrice + CHOKE_DISTANCE_POINTS;

    // Ensure choke stop locks in profit (must be better than entry)
    const locksProfit = trade.direction === 'LONG'
        ? tightStop > trade.entryPrice
        : tightStop < trade.entryPrice;

    if (!locksProfit) {
        tightStop = trade.direction === 'LONG'
            ? trade.entryPrice + 0.25
            : trade.entryPrice - 0.25;
    }

    const label = trade.isChokeActive ? 'TIGHTENED' : 'ENGAGED';
    console.log(
        `[MoMEngine] 🤏 Choke Hold ${label}: Stop → $${tightStop}` +
        ` (${CHOKE_DISTANCE_POINTS}pts behind @ $${currentPrice}) | Profit: ${profitPoints.toFixed(1)}pts`
    );

    parentPort!.postMessage({ type: 'TELEMETRY', payload: {
        source: 'MoM', regime: trade.isWilderness ? 'Wilderness' : 'Killzone',
        message: `CHOKE_HOLD_${label}: ${trade.symbol} stop → $${tightStop}. Profit: ${profitPoints.toFixed(1)}pts`
    }});

    parentPort!.postMessage({
        type:    'trade_command',
        payload: { action: 'TIGHTEN_STOP', symbol: trade.symbol, stopPrice: tightStop, direction: trade.direction },
    });

    trade.isChokeActive = true;
}

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
    const isTestTrade = reason.includes('TEST_TRADE');
    console.log(`[MoMEngine] 🧹 Triple-Sweep PHASE 1 initiated | Reason: ${reason}`);

    // Only log telemetry for real trades — test trades are internal preflight
    if (!isTestTrade) {
        parentPort!.postMessage({ type: 'TELEMETRY', payload: {
            source: 'MoM', regime: trade.isWilderness ? 'Wilderness' : 'Killzone',
            message: `EXIT: ${trade.symbol} ${trade.direction} | Entry: ${trade.entryPrice} | Reason: ${reason}`
        }});
    }

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
            const enriched = tick as any;

            // CRITICAL: Skip CFE/VX ticks — only process CME (ES/MES)
            if (enriched.dataset && enriched.dataset !== 'GLBX.MDP3') break;

            if (isTestingTrade && engineState === 'IDLE') {
                isTestingTrade = false;
                engineState = 'IN_TRADE';
                const tradeSymbol = ContractBuilder.getActiveContract(config.INDICES);

                activeTrade = { symbol: tradeSymbol, direction: 'LONG', entryPrice: enriched.price, stopPrice: enriched.price - 100, entryTs: enriched.timestamp, isWilderness: false, beTriggered: false, candlesSinceEntry: 0, volumeHistory: [], candleHighHistory: [], candleLowHistory: [], isChokeActive: false };

                parentPort!.postMessage({ type: 'trade_command', payload: { action: 'TEST_ENTER', symbol: tradeSymbol, price: enriched.price } });

                setTimeout(() => {
                    parentPort!.postMessage({ type: 'trade_command', payload: { action: 'FLATTEN_ALL', symbol: tradeSymbol, reason: 'TEST_TRADE_COMPLETE' } });
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
                    console.log(`[MoMEngine] 🏔️  Short Leash: Trailing stop → BE @ ${activeTrade.entryPrice} (${activeTrade.symbol})`);
                    parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                        source: 'MoM', regime: 'Wilderness',
                        message: `BE_TRIGGER: ${activeTrade.symbol} trailing stop to breakeven @ ${activeTrade.entryPrice}`
                    }});
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
            console.error('[MoMEngine] 🚨 EMERGENCY_EXIT — flattening all positions!');
            parentPort!.postMessage({ type: 'trade_command', payload: { action: 'FLATTEN_ALL', reason: data.reason } });
            initiateTripleSweepPhase1('EMERGENCY_EXIT');
            break;
        }

        case 'defcon_change': {
            const level = data.level as string;
            isDefconRed = level === 'RED';
            if (isDefconRed) {
                console.warn('[MoMEngine] DefconLevel RED — halting new entries (data flow continues).');
            } else {
                console.log('[MoMEngine] DefconLevel GREEN — entries re-enabled.');
            }
            break;
        }

        case 'HYDRATION': {
            const p = data.payload as any;
            const cmeCandles = p.cmeCandles || [];
            for (const c of cmeCandles) {
                smcExpert.analyze({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, timestamp: c.timestamp }, true);
                aggregator.processTick({ price: c.close, volume: c.volume, timestamp: c.timestamp + 59_000 });
            }
            break;
        }

        case 'SYSTEM_RESET': {
            console.log('[MoMEngine] SYSTEM_RESET — clearing DEFCON, resetting state.');
            isDefconRed = false;
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
                console.log(`[MoMEngine] ORB_SETUP ignored — engine is ${engineState}.`);
                return;
            }
            if (!isHuntingActive) return;  // Warmup gate — no trades until hydration complete

            // DEFCON RED gate: suppress ORB entries (mirrors SMC pipeline gate)
            if (isDefconRed) {
                console.log(`[MoMEngine] ORB_SETUP blocked — DEFCON RED active.`);
                parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                    source: 'MoM', regime: 'DEFCON',
                    message: `DEFCON_RED: ORB ${setup.direction} blocked for ${setup.symbol}. Vol: ${setup.volumeRatio.toFixed(2)}×`,
                }});
                return;
            }

            const inWilderness = MarketClock.isWilderness(setup.ts);
            const zoneLabel    = inWilderness ? '🌲 WILDERNESS' : '🎯 KILLZONE';
            console.log(
                `[MoMEngine] 📡 ORB_SETUP | ${setup.symbol} ${setup.direction} | ` +
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

            console.log(`[MoMEngine] 🟢 GREEN_LIGHT from Oracle — proceeding with ${setup.symbol} ${setup.direction}.`);
            parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                source: 'MoM', regime: inWilderness ? 'Wilderness' : 'Killzone',
                message: `ENTER_ORB: ${setup.symbol} ${setup.direction} @ ${setup.breakoutPrice} | Vol: ${setup.volumeRatio.toFixed(2)}x`
            }});

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
                candlesSinceEntry: 0, volumeHistory: [], candleHighHistory: [], candleLowHistory: [], isChokeActive: false,
            };

            // Wilderness: set auto-scratch timer
            if (inWilderness) {
                activeTrade.scratchTimer = setTimeout(() => {
                    if (activeTrade && !activeTrade.beTriggered) {
                        console.warn(`[MoMEngine] 🌲 Wilderness scratch — no displacement after ${WILDERNESS_SCRATCH_MS / 60000} min. Exiting.`);
                        parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                            source: 'MoM', regime: 'Wilderness',
                            message: `CHOKED: ${activeTrade.symbol} no displacement. Auto-scratch.`
                        }});
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
                    source:      'ORB',
                },
            });
            break;
        }

        /**
         * IMMINENT_REVERSION — Toxic opposing flow detected by Tactical Overwatch.
         */
        case 'IMMINENT_REVERSION': {
            const warn = data.payload as { symbol: string; currentPrice: number; volumeRatio: number; priceDeltaPct: number };
            console.warn(
                `[MoMEngine] ⚠️  IMMINENT_REVERSION | ${warn.symbol} | ` +
                `Vol: ${warn.volumeRatio.toFixed(2)}× | Δ: ${warn.priceDeltaPct.toFixed(3)}%`
            );
            if (activeTrade) {
                const tightStop = activeTrade.direction === 'LONG'
                    ? warn.currentPrice - CHOKE_DISTANCE_POINTS
                    : warn.currentPrice + CHOKE_DISTANCE_POINTS;
                parentPort!.postMessage({
                    type:    'trade_command',
                    payload: { action: 'TIGHTEN_STOP', symbol: warn.symbol, stopPrice: tightStop, direction: activeTrade.direction, reason: 'IMMINENT_REVERSION' },
                });
            }
            break;
        }

        case 'DEFCON_RED': {
            console.warn('[MoMEngine] DEFCON_RED from AssistantWorker — blocking new entries.');
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

        case 'HUNTING_ACTIVE': {
            isHuntingActive = true;
            break;
        }

        case 'shutdown': {
            console.log('[MoMEngine] Shutting down…');
            if (activeTrade?.scratchTimer) clearTimeout(activeTrade.scratchTimer);
            oraclePort?.close();
            assistPort?.close();
            process.exit(0);
            break;
        }

        default:
            console.warn(`[MoMEngine] Unknown message type: ${msg.type}`);
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
    // ── EOD 16:30 Rolling Sweep (15min before Tradovate margin deadline) ──
    if (MarketClock.isEndOfDayFlatten(candle.timestamp)) {
        if (activeTrade) {
            console.log(`[MoMEngine] 🕐 EOD SWEEP — flattening ${activeTrade.symbol} at 16:30 ET.`);
            parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                source: 'MoM', regime: 'EOD',
                message: `EOD_FLATTEN: ${activeTrade.symbol} ${activeTrade.direction} forced exit at 16:30 ET.`
            }});
            parentPort!.postMessage({
                type: 'trade_command',
                payload: { action: 'FLATTEN_ALL', symbol: activeTrade.symbol, reason: 'EOD_FLATTEN_1630' },
            });
            initiateTripleSweepPhase1('EOD_FLATTEN_1630');
        }
        return;  // No new signals during EOD window
    }

    // ── Analyze candle for SMC structure (used by both ATM + signal pipeline)
    // Indicators-only mode: update ATR/VWAP/FVG registry but don't consume
    // FVGs via tap scanning. Activated when:
    //   1. Engine is IN_TRADE (can't act on signals)
    //   2. Hunting not yet active (warmup / race window)
    const indicatorsOnly = !isHuntingActive || (engineState === 'IN_TRADE' && !!activeTrade);
    const signal: SmcSignal = smcExpert.analyze(candle, indicatorsOnly);

    // ── Active Trade Monitor (per-candle while IN_TRADE) ─────────────────
    if (engineState === 'IN_TRADE' && activeTrade) {
        monitorActiveTrade(candle, signal);
        return;  // Don't evaluate new entries while monitoring
    }

    // ── SMC Signal Pipeline (only when IDLE + hunting) ───────────────────
    processSmcSignal(candle, signal).catch((err: Error) =>
        console.error('[MoMEngine] SMC pipeline error:', err.message)
    );
}

/**
 * Full SMC signal evaluation + Handshake + Wilderness gate + entry dispatch.
 * Mirrors the ORB_SETUP flow so both signal sources share the same execution path.
 */
async function processSmcSignal(candle: Candle, signal: SmcSignal): Promise<void> {
    if (signal.action === 'HOLD') return;
    if (engineState !== 'IDLE')  return;
    if (!isHuntingActive)        return;  // Warmup gate — no trades until hydration complete

    // DEFCON RED gate: indicators stay primed but no new entries
    if (isDefconRed) {
        console.log(`[MoMEngine] SMC ${signal.action} blocked — DEFCON RED active.`);
        parentPort!.postMessage({ type: 'TELEMETRY', payload: {
            source: 'MoM', regime: 'DEFCON',
            message: `DEFCON_RED: SMC ${signal.action} blocked. Conf=${signal.confidence}. ${signal.reason}`
        }});
        return;
    }

    // Minimum confidence gate — only high-probability setups
    if (signal.confidence < MIN_SMC_CONFIDENCE) {
        console.log(
            `[MoMEngine] SMC ${signal.action} below confidence threshold ` +
            `(${signal.confidence}/${MIN_SMC_CONFIDENCE}). Skipping. Reason: ${signal.reason}`
        );
        parentPort!.postMessage({ type: 'TELEMETRY', payload: {
            source: 'MoM',
            regime: 'Killzone',
            message: `LOW_CONF: ${signal.reason} — conf=${signal.confidence} (min=${MIN_SMC_CONFIDENCE})`,
        }});
        return;
    }

    const direction: 'LONG' | 'SHORT' = signal.action === 'BUY' ? 'LONG' : 'SHORT';
    const tradeSymbol = ContractBuilder.getActiveContract(config.INDICES);
    const inWilderness = MarketClock.isWilderness(candle.timestamp);
    const zoneLabel    = inWilderness ? '🌲 WILDERNESS' : '🎯 KILLZONE';

    console.log(
        `[MoMEngine] 📊 SMC Signal | ${tradeSymbol} ${direction} | ` +
        `Zone: ${zoneLabel} | C: ${candle.close} | Confidence: ${signal.confidence}/8 | ${signal.reason}`
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

    console.log(`[MoMEngine] 🟢 GREEN_LIGHT — executing ${tradeSymbol} ${direction}.`);
    parentPort!.postMessage({ type: 'TELEMETRY', payload: {
        source: 'MoM', regime: inWilderness ? 'Wilderness' : 'Killzone',
        message: `ENTER_SMC: ${tradeSymbol} ${direction} @ ${candle.close} | Conf: ${signal.confidence}/8 | ${signal.reason}`
    }});

    // ── DYNAMIC STOP LOSS (ATR-based with Wilderness override) ────────────────
    const atr = smcExpert.getATR();
    let slDistance = atr > 0 ? Math.max(5, Math.ceil(atr * 1.5)) : SL_NORMAL_POINTS;

    if (inWilderness) {
        slDistance = Math.ceil(slDistance * SL_WILDERNESS_PCT);
        parentPort!.postMessage({ type: 'TELEMETRY', payload: {
            source:  'MoM',
            regime:  'Wilderness',
            message: `SMC Short Leash activated for ${tradeSymbol} ${direction}: SL → ${slDistance} pts (ATR: ${atr.toFixed(2)}).`,
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
        candlesSinceEntry: 0, volumeHistory: [], candleHighHistory: [], candleLowHistory: [], isChokeActive: false,
    };

    if (inWilderness) {
        activeTrade.scratchTimer = setTimeout(() => {
            if (activeTrade && !activeTrade.beTriggered) {
                console.warn('[MoMEngine] 🌲 SMC Wilderness scratch — no displacement.');
                parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                    source: 'MoM', regime: 'Wilderness',
                    message: `CHOKED: ${activeTrade.symbol} no displacement. Auto-scratch.`
                }});
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
            confidence:  signal.confidence,
        },
    });
}
