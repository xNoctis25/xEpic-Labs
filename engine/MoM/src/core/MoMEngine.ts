/**
 * MoMEngine.ts — Core 1 (M.o.M Signal Engine)
 * ─────────────────────────────────────────────────────────────────────────────
 * Thin IPC wrapper around TradingCore.
 * 
 * Responsibilities:
 *   • Wires IPC ports (parentPort, oraclePort, assistPort)
 *   • Feeds live ticks to TradingCore
 *   • Translates TradeAction[] into IPC messages to broker/workers
 *   • Handles Oracle handshake (async gate before entries)
 *   • DEFCON state management (received from Oracle)
 *   • Test trade sequence at boot
 *   • Triple-Sweep Phase 1 on exit
 *
 * ALL trading logic lives in TradingCore (SMC, ATM, stops, R-based management).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import '../utils/etLogger';
import { parentPort, MessagePort } from 'worker_threads';
import { MarketClock }             from './MarketClock';
import { Candle, Tick }            from '../market/CandleAggregator';
import { TradingCore, TradeAction } from './TradingCore';
import { ContractBuilder }         from '../utils/ContractBuilder';
import { config }                  from '../config/env';

if (!parentPort) throw new Error('[MoMEngine] Must be run as a worker thread.');

// ─── Peer ports ──────────────────────────────────────────────────────────────
let oraclePort: MessagePort | null = null;
let assistPort: MessagePort | null = null;

// ─── Engine state ────────────────────────────────────────────────────────────
type EngineState = 'IDLE' | 'AWAITING_HANDSHAKE' | 'IN_TRADE';
let engineState: EngineState = 'IDLE';
let isTestingTrade = true;  // Armed immediately — test trade fires on first tick
let isHuntingActive = false;

// ─── TradingCore — THE BRAIN ─────────────────────────────────────────────────
const tradeSymbol = ContractBuilder.getActiveContract(config.INDICES);
const core = new TradingCore(tradeSymbol);

// DEFCON state (received from Oracle)
let isDefconRed = false;

// Wilderness auto-scratch timer
const WILDERNESS_SCRATCH_MS = 3 * 60_000;
let wildernessTimer: ReturnType<typeof setTimeout> | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// ORACLE HANDSHAKE — REQUEST_TAKEOFF / GREEN_LIGHT
// ─────────────────────────────────────────────────────────────────────────────
const HANDSHAKE_TIMEOUT_MS = 3000;
const pendingHandshakes = new Map<string, (light: 'GREEN_LIGHT' | 'RED_LIGHT') => void>();

function requestTakeoff(symbol: string, direction: string): Promise<'GREEN_LIGHT' | 'RED_LIGHT'> {
    return new Promise((resolve) => {
        const correlationId = `${symbol}-${Date.now()}`;
        pendingHandshakes.set(correlationId, resolve);

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
        void timer;
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// TRIPLE-SWEEP — Phase 1
// ─────────────────────────────────────────────────────────────────────────────
function initiateTripleSweepPhase1(reason: string): void {
    const trade = core.getActiveTrade();
    if (!trade && !reason.includes('TEST_TRADE')) return;

    const isTestTrade = reason.includes('TEST_TRADE');
    console.log(`[MoMEngine] 🧹 Triple-Sweep PHASE 1 initiated | Reason: ${reason}`);

    // Cancel local working orders
    parentPort!.postMessage({
        type: 'trade_command',
        payload: { action: 'CANCEL_ALL_ORDERS' },
    });

    if (trade) {
        // Notify AssistantWorker
        assistPort?.postMessage({
            type:    'TRADE_CLOSED',
            payload: { symbol: trade.symbol, direction: trade.direction, entryPrice: trade.entryPrice, reason },
        });

        // Notify parentPort → triggers Phase 2 (AssistantWorker) → Phase 3 (Oracle) → system_reset
        assistPort?.postMessage({
            type: 'SWEEP_PHASE_1_COMPLETE',
            payload: { symbol: trade.symbol, direction: trade.direction, entryPrice: trade.entryPrice, reason },
        });
    }

    // Clear wilderness timer
    if (wildernessTimer) { clearTimeout(wildernessTimer); wildernessTimer = null; }

    // Reset TradingCore state
    core.resetTradeState();
    engineState = 'IDLE';

    if (isTestTrade) {
        console.log('[MoMEngine] ✅ Test trade complete — engine ready for live signals.');
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTION DISPATCHER — translates TradingCore actions into IPC messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Process actions from TradingCore and dispatch via IPC.
 * ENTER actions go through Oracle handshake first.
 */
async function dispatchActions(actions: TradeAction[]): Promise<void> {
    for (const action of actions) {
        switch (action.type) {
            case 'ENTER': {
                if (engineState !== 'IDLE') break;

                const symbol = ContractBuilder.getActiveContract(config.INDICES);
                const inWilderness = action.regime === 'Wilderness';
                const zoneLabel = inWilderness ? '🌲 WILDERNESS' : '🎯 KILLZONE';

                console.log(
                    `[MoMEngine] 📊 SMC Signal | ${symbol} ${action.direction} | ` +
                    `Zone: ${zoneLabel} | C: ${action.price} | Probability: ${action.confidence}% | ${action.reason}`
                );

                // ── ORACLE HANDSHAKE ──
                engineState = 'AWAITING_HANDSHAKE';
                const light = await requestTakeoff(symbol, action.direction!);

                if (light === 'RED_LIGHT') {
                    console.log(`[MoMEngine] 🔴 RED_LIGHT — Oracle blocked ${symbol} ${action.direction}.`);
                    parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                        source: 'MoM', regime: action.regime,
                        message: `REJECTED by ORACLE | ${action.direction} ${symbol} @ ${action.price} | Prob: ${action.confidence}% | ${action.reason}`,
                    }});
                    engineState = 'IDLE';
                    break;
                }

                // ── GREEN LIGHT — ENTER ──
                console.log(`[MoMEngine] 🟢 GREEN_LIGHT — executing ${symbol} ${action.direction}.`);
                core.confirmEntry(action);
                engineState = 'IN_TRADE';

                parentPort!.postMessage({ type: 'TELEMETRY_TRADE_OPEN', payload: {
                    source: 'MoM', regime: action.regime, tradeId: action.tradeId,
                    message: `ENTER_SMC: ${symbol} ${action.direction} @ ${action.price} | Prob: ${action.confidence}% | ${action.reason}`
                }});

                if (inWilderness) {
                    parentPort!.postMessage({ type: 'TELEMETRY_TRADE_UPDATE', payload: {
                        tradeId: action.tradeId,
                        event: `SHORT_LEASH: Wilderness SL → ${action.riskR!.toFixed(1)} pts`,
                    }});

                    wildernessTimer = setTimeout(() => {
                        const trade = core.getActiveTrade();
                        if (trade && !trade.beTriggered) {
                            console.warn('[MoMEngine] 🌲 SMC Wilderness scratch — no displacement.');
                            parentPort!.postMessage({ type: 'TELEMETRY_TRADE_UPDATE', payload: {
                                tradeId: trade.tradeId,
                                event: `CHOKED: no displacement. Auto-scratch.`
                            }});
                            parentPort!.postMessage({
                                type: 'trade_command',
                                payload: { action: 'FLATTEN_ALL', symbol: trade.symbol, reason: 'WILDERNESS_NO_DISPLACEMENT' },
                            });
                            initiateTripleSweepPhase1('WILDERNESS_NO_DISPLACEMENT');
                        }
                    }, WILDERNESS_SCRATCH_MS);
                }

                // Notify AssistantWorker
                assistPort?.postMessage({
                    type: 'IN_TRADE',
                    payload: { symbol, direction: action.direction, entryPrice: action.price, entryTs: Date.now(), stopPrice: action.stopPrice },
                });

                // Forward to broker
                parentPort!.postMessage({
                    type: 'trade_command',
                    payload: {
                        action:      'ENTER',
                        symbol,
                        direction:   action.direction,
                        price:       action.price,
                        stopPrice:   action.stopPrice,
                        isWilderness: inWilderness,
                        source:      'SMC',
                        confidence:  action.confidence,
                    },
                });
                break;
            }

            case 'EXIT': {
                const trade = core.getActiveTrade();
                if (!trade) break;

                console.log(`[MoMEngine] 🔄 EXIT: ${action.reason}`);
                parentPort!.postMessage({ type: 'TELEMETRY_TRADE_UPDATE', payload: {
                    tradeId: action.tradeId ?? trade.tradeId,
                    event: `CHOKED: ${action.reason}`
                }});
                parentPort!.postMessage({
                    type: 'trade_command',
                    payload: { action: 'FLATTEN_ALL', symbol: trade.symbol, reason: action.reason },
                });
                initiateTripleSweepPhase1(action.reason);
                break;
            }

            case 'MOVE_STOP': {
                const trade = core.getActiveTrade();
                if (!trade) break;

                console.log(`[MoMEngine] 🏔️  Breakeven @ 1R: stop → ${action.stopPrice}`);
                parentPort!.postMessage({ type: 'TELEMETRY_TRADE_UPDATE', payload: {
                    tradeId: trade.tradeId,
                    event: action.reason,
                }});
                parentPort!.postMessage({
                    type: 'trade_command',
                    payload: { action: 'MOVE_STOP_TO_BE', symbol: trade.symbol, stopPrice: action.stopPrice },
                });
                break;
            }

            case 'TIGHTEN_STOP': {
                const trade = core.getActiveTrade();
                if (!trade) break;

                console.log(`[MoMEngine] 🤏 Tighten stop → ${action.stopPrice}`);
                parentPort!.postMessage({ type: 'TELEMETRY_TRADE_UPDATE', payload: {
                    tradeId: trade.tradeId,
                    event: action.reason,
                }});
                parentPort!.postMessage({
                    type: 'trade_command',
                    payload: { action: 'TIGHTEN_STOP', symbol: trade.symbol, stopPrice: action.stopPrice, direction: action.direction },
                });
                break;
            }

            case 'REJECTED': {
                console.log(`[MoMEngine] ❌ ${action.reason}`);
                parentPort!.postMessage({ type: 'TELEMETRY', payload: {
                    source: 'MoM',
                    regime: action.regime,
                    message: action.reason,
                }});
                break;
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// IPC: Oracle → MomWorker
// ─────────────────────────────────────────────────────────────────────────────
function onOracleMessage(data: { type: string; [key: string]: unknown }): void {
    switch (data.type) {

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

        case 'tick': {
            const tick = data.payload as Tick;
            const enriched = tick as any;

            // CRITICAL: Skip CFE/VX ticks — only process CME (ES/MES)
            if (enriched.dataset && enriched.dataset !== 'GLBX.MDP3') break;

            // Test trade sequence (fires once on first tick)
            if (isTestingTrade && engineState === 'IDLE') {
                isTestingTrade = false;
                engineState = 'IN_TRADE';
                const symbol = ContractBuilder.getActiveContract(config.INDICES);

                // Create test trade in TradingCore
                core.confirmEntry({
                    type: 'ENTER', direction: 'LONG',
                    price: enriched.price, stopPrice: enriched.price - 100,
                    riskR: 100, tradeId: `TEST-${Date.now()}`,
                    reason: 'TEST_TRADE', regime: 'Killzone',
                });
                engineState = 'IN_TRADE';

                parentPort!.postMessage({ type: 'trade_command', payload: { action: 'TEST_ENTER', symbol, price: enriched.price } });

                setTimeout(() => {
                    parentPort!.postMessage({ type: 'trade_command', payload: { action: 'FLATTEN_ALL', symbol, reason: 'TEST_TRADE_COMPLETE' } });
                }, 15000);
            }

            // Feed tick to TradingCore — get actions back
            const actions = core.onTick(tick);
            if (actions.length > 0) {
                dispatchActions(actions).catch((err: Error) =>
                    console.error('[MoMEngine] Action dispatch error:', err.message)
                );
            }
            break;
        }

        case 'EMERGENCY_EXIT': {
            console.error('[MoMEngine] 🚨 EMERGENCY_EXIT — flattening all positions!');
            parentPort!.postMessage({ type: 'trade_command', payload: { action: 'FLATTEN_ALL', reason: data.reason } });
            initiateTripleSweepPhase1('EMERGENCY_EXIT');
            break;
        }

        case 'defcon_change': {
            const level = data.level as string;
            isDefconRed = level === 'RED';
            core.isDefconRed = isDefconRed;  // Sync to TradingCore
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

            const hydrationCandles: Candle[] = cmeCandles.map((c: any) => ({
                open: c.open, high: c.high, low: c.low, close: c.close,
                volume: c.volume, buyVolume: 0, sellVolume: 0, timestamp: c.timestamp,
            }));

            // Hydrate TradingCore (feeds both MTF analyzer and SMC expert)
            core.hydrate(hydrationCandles);

            // Print MTF bias after hydration
            const mtf = core.getMtfAnalyzer();
            const snap = mtf.getSnapshot();
            console.log(
                `[M.o.M] 📊 Multi-Timeframe Analysis Complete\n` +
                `         1H: ${snap.tf1h.trend} (${snap.tf1h.candleCount} candles) | ` +
                `15M: ${snap.tf15m.trend} (${snap.tf15m.candleCount} candles) | ` +
                `5M: ${snap.tf5m.trend} (${snap.tf5m.candleCount} candles)\n` +
                `         Dominant Bias: ${snap.dominantBias} | Alignment: ${snap.alignmentScore}/3 | Ready: ${snap.isReady ? '✅' : '❌'}`
            );
            break;
        }

        case 'SYSTEM_RESET': {
            console.log('[MoMEngine] SYSTEM_RESET — clearing DEFCON, resetting state.');
            isDefconRed = false;
            core.isDefconRed = false;
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

        case 'IMMINENT_REVERSION': {
            const warn = data.payload as { symbol: string; currentPrice: number; volumeRatio: number; priceDeltaPct: number };
            console.warn(
                `[MoMEngine] ⚠️  IMMINENT_REVERSION | ${warn.symbol} | ` +
                `Vol: ${warn.volumeRatio.toFixed(2)}× | Δ: ${warn.priceDeltaPct.toFixed(3)}%`
            );
            const reversion = core.handleImminentReversion(warn.currentPrice);
            if (reversion) {
                parentPort!.postMessage({
                    type: 'trade_command',
                    payload: { action: 'TIGHTEN_STOP', symbol: warn.symbol, stopPrice: reversion.stopPrice, direction: reversion.direction, reason: 'IMMINENT_REVERSION' },
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

        case 'position_closed': {
            initiateTripleSweepPhase1(msg.reason as string ?? 'BROKER_CONFIRMED_EXIT');
            break;
        }

        case 'HUNTING_ACTIVE': {
            isHuntingActive = true;
            core.isHuntingActive = true;  // Sync to TradingCore
            break;
        }

        case 'shutdown': {
            console.log('[MoMEngine] Shutting down…');
            if (wildernessTimer) clearTimeout(wildernessTimer);
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
// Heartbeat snapshot — used by Main for verbose logging
// ─────────────────────────────────────────────────────────────────────────────
export function getSmcExpert() { return core.getSmcExpert(); }
