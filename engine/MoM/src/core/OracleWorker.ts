/**
 * OracleWorker.ts — Core 3
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   • Owns the Databento TCP socket — SOLE source of market data.
 *   • Fans candle data out to MomWorker via direct IPC port.
 *   • Fans market context (session info, news flags) to AssistantWorker.
 *   • Posts connection health status back to Main (Core 4).
 *
 * IPC Ports received on startup (via parentPort 'init' message):
 *   • momPort    – MessagePort shared with MomWorker    (write candles/ticks)
 *   • assistPort – MessagePort shared with AssistantWorker (write context)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { parentPort, MessagePort } from 'worker_threads';

if (!parentPort) throw new Error('[OracleWorker] Must be run as a worker thread.');

// ── Peer ports (wired by Main via MessageChannel) ───────────────────────────
let momPort:    MessagePort | null = null;
let assistPort: MessagePort | null = null;

// ── Main IPC handler ─────────────────────────────────────────────────────────
parentPort.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {

        /**
         * 'init' — sent once by Main (Core 4) on startup.
         * Carries the two direct peer MessagePorts.
         */
        case 'init': {
            momPort    = msg.momPort    as MessagePort;
            assistPort = msg.assistPort as MessagePort;

            parentPort!.postMessage({ type: 'ready', worker: 'OracleWorker' });
            console.log('[OracleWorker] Core 3 online — IPC mesh wired.');

            // Begin market data feed (Databento TCP)
            startDatabentoFeed();
            break;
        }

        /**
         * 'subscribe' — sent by Main to subscribe to a specific instrument.
         */
        case 'subscribe': {
            const symbol = msg.symbol as string;
            console.log(`[OracleWorker] Subscribing to: ${symbol}`);
            // TODO Phase 2: register symbol with Databento TCP client
            break;
        }

        /**
         * 'shutdown' — graceful teardown signal from Main.
         */
        case 'shutdown': {
            console.log('[OracleWorker] Shutting down feed…');
            stopDatabentoFeed();
            momPort?.close();
            assistPort?.close();
            process.exit(0);
        }

        default:
            console.warn(`[OracleWorker] Unknown message type: ${msg.type}`);
    }
});

// ── Databento TCP feed lifecycle ─────────────────────────────────────────────
let feedInterval: ReturnType<typeof setInterval> | null = null;

function startDatabentoFeed(): void {
    console.log('[OracleWorker] Starting Databento TCP feed…');

    // TODO Phase 2: replace stub with real DatabentoCient TCP socket
    // Stub: emit a synthetic candle every 5 seconds for integration testing
    feedInterval = setInterval(() => {
        const syntheticCandle = {
            symbol:    'ES',
            timestamp: Date.now(),
            open:      5200.00,
            high:      5202.50,
            low:       5199.25,
            close:     5201.75,
            volume:    1234,
        };

        // Fan out candle to MomWorker
        momPort?.postMessage({ type: 'candle', payload: syntheticCandle });

        // Fan out market context to AssistantWorker
        assistPort?.postMessage({
            type:    'market_context',
            session: 'NY_AM',
            payload: syntheticCandle,
        });

        // Notify Main of feed health
        parentPort!.postMessage({ type: 'feed_heartbeat', ts: Date.now() });

    }, 5000);
}

function stopDatabentoFeed(): void {
    if (feedInterval) {
        clearInterval(feedInterval);
        feedInterval = null;
    }
    console.log('[OracleWorker] Feed stopped.');
}
