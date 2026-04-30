/**
 * AssistantWorker.ts — Core 2
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • Handles Nova AI assistant requests (LLM calls, context management).
 *   • Generates performance analytics & trade journal summaries.
 *   • Receives engine state updates from MomWorker.
 *   • Receives market context from OracleWorker.
 *   • Posts alerts / assistant responses back to Main (Core 4) for
 *     delivery to the dashboard WebSocket.
 *
 * IPC Ports received on startup (via parentPort 'init' message):
 *   • momPort    – MessagePort shared with MomWorker    (read engine state)
 *   • oraclePort – MessagePort shared with OracleWorker (read market context)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parentPort, MessagePort } from 'worker_threads';

if (!parentPort) throw new Error('[AssistantWorker] Must be run as a worker thread.');

// ── Peer ports (wired by Main via MessageChannel) ───────────────────────────
let momPort:    MessagePort | null = null;
let oraclePort: MessagePort | null = null;

// ── Main IPC handler ─────────────────────────────────────────────────────────
parentPort.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {

        /**
         * 'init' — sent once by Main (Core 4) on startup.
         * Carries the two direct peer MessagePorts.
         */
        case 'init': {
            momPort    = msg.momPort    as MessagePort;
            oraclePort = msg.oraclePort as MessagePort;

            // Listen for engine state updates from MomWorker
            momPort.on('message', onEngineState);

            // Listen for market context from OracleWorker
            oraclePort.on('message', onMarketContext);

            parentPort!.postMessage({ type: 'ready', worker: 'AssistantWorker' });
            console.log('[AssistantWorker] Core 2 online — IPC mesh wired.');
            break;
        }

        /**
         * 'query' — sent by Main when the dashboard sends a Nova question.
         */
        case 'query': {
            const question = msg.payload as string;
            handleAssistantQuery(question);
            break;
        }

        /**
         * 'shutdown' — graceful teardown signal from Main.
         */
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

// ── Engine state handler (MomWorker → AssistantWorker) ──────────────────────
function onEngineState(data: { type: string; [key: string]: unknown }): void {
    if (data.type === 'engine_state') {
        // TODO Phase 2: update internal context store for LLM awareness
        console.log('[AssistantWorker] Engine state update:', data.state);
    }
}

// ── Market context handler (OracleWorker → AssistantWorker) ─────────────────
function onMarketContext(data: { type: string; [key: string]: unknown }): void {
    if (data.type === 'market_context') {
        // TODO Phase 2: store market context for assistant responses
        console.log('[AssistantWorker] Market context received.');
    }
}

// ── Nova AI query handler ────────────────────────────────────────────────────
async function handleAssistantQuery(question: string): Promise<void> {
    console.log(`[AssistantWorker] Processing query: "${question}"`);

    // TODO Phase 2: inject LLM client (Gemini/OpenAI) + RAG context
    const response = `[AssistantWorker stub] Query received: "${question}"`;

    // Post response back to Main for WebSocket delivery to dashboard
    parentPort!.postMessage({
        type:    'assistant_response',
        payload: response,
    });
}
