/**
 * MomWorker.ts — Core 1
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • Receives candle / tick data from OracleWorker via direct IPC port.
 *   • Runs EvaluationEngine + ExecutionEngine logic.
 *   • Sends trade commands upstream to Main (Core 4) for broker dispatch.
 *   • Sends status updates to AssistantWorker via direct IPC port.
 *
 * IPC Ports received on startup (via parentPort 'init' message):
 *   • oraclePort   – MessagePort shared with OracleWorker  (read market data)
 *   • assistPort   – MessagePort shared with AssistantWorker (write status)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parentPort, MessagePort } from 'worker_threads';

if (!parentPort) throw new Error('[MomWorker] Must be run as a worker thread.');

// ── Peer ports (wired by Main via MessageChannel) ───────────────────────────
let oraclePort:  MessagePort | null = null;
let assistPort:  MessagePort | null = null;

// ── Main IPC handler ─────────────────────────────────────────────────────────
parentPort.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {

        /**
         * 'init' — sent once by Main (Core 4) on startup.
         * Carries the two direct peer MessagePorts.
         */
        case 'init': {
            oraclePort = msg.oraclePort as MessagePort;
            assistPort = msg.assistPort as MessagePort;

            // Listen for market data coming directly from OracleWorker
            oraclePort.on('message', onMarketData);

            parentPort!.postMessage({ type: 'ready', worker: 'MomWorker' });
            console.log('[MomWorker] Core 1 online — IPC mesh wired.');
            break;
        }

        /**
         * 'shutdown' — graceful teardown signal from Main.
         */
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

// ── Market data handler (called via direct OracleWorker → MomWorker port) ───
function onMarketData(data: { type: string; [key: string]: unknown }): void {
    switch (data.type) {

        case 'candle': {
            // TODO Phase 2: pass candle into EvaluationEngine
            const candle = data.payload;
            console.log('[MomWorker] Candle received:', candle);

            // After evaluation, notify AssistantWorker of current engine state
            assistPort?.postMessage({
                type:    'engine_state',
                state:   'evaluating',
                payload: candle,
            });

            // TODO Phase 2: if signal fires, post trade command to Main
            // parentPort!.postMessage({ type: 'trade_command', payload: { ... } });
            break;
        }

        case 'tick': {
            // TODO Phase 2: live tick → ActiveTradeMonitor
            break;
        }

        default:
            console.warn(`[MomWorker] Unknown market data type: ${data.type}`);
    }
}
