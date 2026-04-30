/**
 * MomWorker.ts — Core 1
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • Receives candle / tick data from OracleWorker via direct IPC port.
 *   • Receives ORB_SETUP signals from AssistantWorker for execution approval.
 *   • Receives IMMINENT_REVERSION warnings from AssistantWorker.
 *   • Runs EvaluationEngine + ExecutionEngine logic.
 *   • Broadcasts IN_TRADE / TRADE_CLOSED lifecycle events to AssistantWorker.
 *   • Sends trade commands upstream to Main (Core 4) for broker dispatch.
 *
 * IPC Ports received on startup (via parentPort 'init' message):
 *   • oraclePort  – MessagePort ↔ OracleWorker   (read ticks + EMERGENCY_EXIT)
 *   • assistPort  – MessagePort ↔ AssistantWorker (read ORB_SETUP + alerts)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parentPort, MessagePort } from 'worker_threads';

if (!parentPort) throw new Error('[MomWorker] Must be run as a worker thread.');

// ─── Peer ports ──────────────────────────────────────────────────────────────
let oraclePort: MessagePort | null = null;
let assistPort: MessagePort | null = null;

// ─── Engine state ────────────────────────────────────────────────────────────
type EngineState = 'IDLE' | 'EVALUATING' | 'IN_TRADE';
let engineState: EngineState = 'IDLE';

// ─── Main IPC handler (from Core 4) ─────────────────────────────────────────
parentPort.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {

        case 'init': {
            oraclePort = msg.oraclePort as MessagePort;
            assistPort = msg.assistPort as MessagePort;

            oraclePort.on('message', onOracleMessage);
            assistPort.on('message', onAssistantMessage);

            parentPort!.postMessage({ type: 'ready', worker: 'MomWorker' });
            console.log('[MomWorker] Core 1 online — IPC mesh wired.');
            break;
        }

        case 'shutdown': {
            console.log('[MomWorker] Shutting down…');
            oraclePort?.close();
            assistPort?.close();
            process.exit(0);
        }

        default:
            console.warn(`[MomWorker] Unknown message type: ${msg.type}`);
    }
});

// ─── OracleWorker → MomWorker ────────────────────────────────────────────────
function onOracleMessage(data: { type: string; [key: string]: unknown }): void {
    switch (data.type) {

        case 'tick': {
            if (engineState !== 'IDLE') return;
            // TODO Phase 4: feed tick into EvaluationEngine
            break;
        }

        case 'candle': {
            // TODO Phase 4: pass into EvaluationEngine
            console.log('[MomWorker] Candle:', data.payload);
            assistPort?.postMessage({ type: 'engine_state', state: engineState, payload: data.payload });
            break;
        }

        /**
         * EMERGENCY_EXIT — fired by OracleWorker on PULL_PLUG command from NOVA.
         * Must immediately flatten all positions.
         */
        case 'EMERGENCY_EXIT': {
            console.error('[MomWorker] 🚨 EMERGENCY_EXIT received — flattening all positions!');
            engineState = 'IDLE';
            parentPort!.postMessage({ type: 'trade_command', payload: { action: 'FLATTEN_ALL', reason: data.reason } });
            assistPort?.postMessage({ type: 'TRADE_CLOSED', payload: { reason: data.reason } });
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

// ─── AssistantWorker → MomWorker ─────────────────────────────────────────────
function onAssistantMessage(data: { type: string; [key: string]: unknown }): void {
    switch (data.type) {

        /**
         * ORB_SETUP — AssistantWorker detected a volume-anomaly breakout.
         * Apply execution filters here before forwarding to broker.
         */
        case 'ORB_SETUP': {
            const setup = data.payload as {
                symbol: string; direction: string; breakoutPrice: number;
                volumeRatio: number; boxHigh: number; boxLow: number; ts: number;
            };

            console.log(
                `[MomWorker] 📡 ORB_SETUP | ${setup.symbol} ${setup.direction} | ` +
                `Vol: ${setup.volumeRatio.toFixed(2)}× | Entry: ${setup.breakoutPrice}`
            );

            if (engineState !== 'IDLE') {
                console.log('[MomWorker] ORB_SETUP ignored — engine not IDLE.');
                return;
            }

            // TODO Phase 4: run killzone + risk engine filters
            engineState = 'IN_TRADE';

            // Notify AssistantWorker to activate Tactical Overwatch
            assistPort?.postMessage({
                type:    'IN_TRADE',
                payload: {
                    symbol:     setup.symbol,
                    direction:  setup.direction,
                    entryPrice: setup.breakoutPrice,
                    entryTs:    setup.ts,
                    stopPrice:  setup.direction === 'LONG' ? setup.boxLow : setup.boxHigh,
                },
            });

            // Forward to Main → Broker
            parentPort!.postMessage({
                type:    'trade_command',
                payload: { action: 'ENTER', ...setup },
            });
            break;
        }

        /**
         * IMMINENT_REVERSION — toxic opposing order flow detected.
         * Trigger tightened stop or accelerated exit.
         */
        case 'IMMINENT_REVERSION': {
            const warn = data.payload as { symbol: string; volumeRatio: number; priceDeltaPct: number };
            console.warn(
                `[MomWorker] ⚠️  IMMINENT_REVERSION | ${warn.symbol} | ` +
                `Vol: ${warn.volumeRatio.toFixed(2)}× | Δ: ${warn.priceDeltaPct.toFixed(3)}%`
            );
            // TODO Phase 4: broker tighten stop or exit
            parentPort!.postMessage({
                type:    'trade_command',
                payload: { action: 'TIGHTEN_STOP', reason: 'IMMINENT_REVERSION', ...warn },
            });
            break;
        }

        case 'DEFCON_RED': {
            console.warn('[MomWorker] DEFCON_RED relayed by AssistantWorker — halting entries.');
            break;
        }

        default: break;
    }
}

// ─── Lifecycle helper ────────────────────────────────────────────────────────
export function notifyTradeClosed(symbol: string, pnl: number): void {
    engineState = 'IDLE';
    assistPort?.postMessage({ type: 'TRADE_CLOSED', payload: { symbol, pnl, ts: Date.now() } });
    parentPort!.postMessage({ type: 'trade_closed', payload: { symbol, pnl } });
}
