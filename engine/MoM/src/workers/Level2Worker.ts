/**
 * Level2Worker — Dedicated Worker Thread for Tradovate Level 2 DOM Ingestion
 *
 * Thread Assignment: Core 2
 *
 * Single-Token Architecture:
 *   Tradovate enforces a 1-token-per-user limit. This worker receives the
 *   main thread's access token via workerData and opens a raw WebSocket
 *   to the MD endpoint. It does NOT call requestToken() — the main thread
 *   owns the token lifecycle (including the 1-hour refresh mutex).
 *
 * Lifecycle:
 *   1. Receives SharedArrayBuffer + accessToken + symbol + mdUrl via workerData
 *   2. Opens a raw WebSocket to wss://md.tradovateapi.com/v1/websocket
 *   3. Authenticates using: authorize\n1\n\n${accessToken}
 *   4. Subscribes to md/subscribeDOM for the given symbol
 *   5. On every DOM update, writes bid/ask data into the SAB using SeqLock
 *   6. Main thread reads the SAB at any time with zero latency
 */

import { workerData, parentPort } from 'worker_threads';
import WebSocket from 'ws';
import {
    HEADER_BYTES, DOM_DEPTH, FIELDS_PER_LEVEL,
    IDX_TIMESTAMP, IDX_BID_COUNT, IDX_ASK_COUNT,
    IDX_BIDS_START, IDX_ASKS_START,
} from './Level2Layout';

// ─── Worker Data from Main Thread ──────────────────────────────────
const { sab, accessToken, symbol, mdUrl } = workerData as {
    sab: SharedArrayBuffer;
    accessToken: string;
    symbol: string;
    mdUrl: string;
};

// ─── Shared Memory Views ───────────────────────────────────────────
const seqLock = new Int32Array(sab, 0, 1);   // SeqLock counter (bytes 0-3)
const data = new Float64Array(sab, HEADER_BYTES); // DOM data (bytes 8+)

// ─── Metrics ───────────────────────────────────────────────────────
let updateCount = 0;
let lastLogTime = Date.now();

// ─── Status Reporter ───────────────────────────────────────────────
function sendStatus(message: string): void {
    parentPort?.postMessage({ type: 'status', message });
}

// ─── Sorting Helpers ───────────────────────────────────────────────
function sortBids(levels: { price: number; size: number }[]): { price: number; size: number }[] {
    return levels.sort((a, b) => b.price - a.price); // Highest price first
}

function sortOffers(levels: { price: number; size: number }[]): { price: number; size: number }[] {
    return levels.sort((a, b) => a.price - b.price); // Lowest price first
}

/**
 * Writes a DOM update into the SharedArrayBuffer using the SeqLock protocol.
 */
function writeDOMToSAB(
    bids: { price: number; size: number }[],
    offers: { price: number; size: number }[],
): void {
    const bidCount = Math.min(bids.length, DOM_DEPTH);
    const askCount = Math.min(offers.length, DOM_DEPTH);

    // Step 1: Signal write-in-progress (odd sequence)
    Atomics.add(seqLock, 0, 1);

    // Step 2: Write the data
    data[IDX_TIMESTAMP] = Date.now();
    data[IDX_BID_COUNT] = bidCount;
    data[IDX_ASK_COUNT] = askCount;

    for (let i = 0; i < bidCount; i++) {
        const offset = IDX_BIDS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = bids[i].price;
        data[offset + 1] = bids[i].size;
    }
    for (let i = bidCount; i < DOM_DEPTH; i++) {
        const offset = IDX_BIDS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = 0;
        data[offset + 1] = 0;
    }

    for (let i = 0; i < askCount; i++) {
        const offset = IDX_ASKS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = offers[i].price;
        data[offset + 1] = offers[i].size;
    }
    for (let i = askCount; i < DOM_DEPTH; i++) {
        const offset = IDX_ASKS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = 0;
        data[offset + 1] = 0;
    }

    // Step 3: Signal write-complete (even sequence)
    Atomics.add(seqLock, 0, 1);

    updateCount++;
}

// ─── WebSocket Connection ──────────────────────────────────────────
sendStatus(`Connecting to MD WebSocket: ${mdUrl}`);
const ws = new WebSocket(mdUrl);

ws.on('open', () => {
    sendStatus('WebSocket connected. Authenticating with shared token...');
    // Authenticate using the main thread's access token (no separate requestToken)
    ws.send(`authorize\n1\n\n${accessToken}`);

    // Subscribe to Level 2 DOM after a short delay for auth to process
    setTimeout(() => {
        sendStatus(`Subscribing to md/subscribeDOM for ${symbol}...`);
        ws.send(`md/subscribeDOM\n2\n\n{"symbol":"${symbol}"}`);
        sendStatus(`DOM subscription sent for ${symbol}. Waiting for data...`);
    }, 2500);
});

ws.on('close', () => {
    sendStatus('🔴 WebSocket disconnected.');
});

ws.on('error', (err) => {
    sendStatus(`🔴 WebSocket error: ${err.message}`);
});

// ─── Heartbeat ─────────────────────────────────────────────────────
setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send('[]');
    }
}, 2500);

// ─── Message Handler ───────────────────────────────────────────────
let rawLogCount = 0;

ws.on('message', (rawData: WebSocket.RawData) => {
    const message = rawData.toString();

    // Debug: log the first 5 non-heartbeat raw frames
    if (rawLogCount < 5 && message !== '[]' && message.trim().length > 0) {
        sendStatus(`WORKER RAW [${rawLogCount + 1}/5]: ${message.substring(0, 500)}`);
        rawLogCount++;
    }

    try {
        if (!message.startsWith('a')) return;

        const payload = JSON.parse(message.slice(1));
        for (const event of payload) {
            // ── DOM Update ──
            if (event.e === 'md/dom') {
                const doms = event.d?.doms;
                if (!doms || !Array.isArray(doms) || doms.length === 0) continue;

                const dom = doms[0]; // Primary contract
                const rawBids: any[] = dom.bids || [];
                const rawOffers: any[] = dom.offers || [];

                const bids = sortBids(
                    rawBids
                        .filter((b: any) => b.price != null && b.size != null)
                        .map((b: any) => ({ price: b.price, size: b.size }))
                );

                const offers = sortOffers(
                    rawOffers
                        .filter((o: any) => o.price != null && o.size != null)
                        .map((o: any) => ({ price: o.price, size: o.size }))
                );

                writeDOMToSAB(bids, offers);
            }

            // ── Subscription errors ──
            if (event.s && event.s !== 200) {
                sendStatus(`🔴 Subscription Error: ${JSON.stringify(event)}`);
            }
            if (event.e === 'error') {
                sendStatus(`🔴 Server Error Event: ${JSON.stringify(event)}`);
            }
        }
    } catch (err) {
        // Discard malformed frames
    }
});

// ─── Periodic Throughput Logger ────────────────────────────────────
setInterval(() => {
    const elapsed = (Date.now() - lastLogTime) / 1000;
    const rate = Math.round(updateCount / elapsed);
    sendStatus(`SAB writes: ${updateCount} total | ${rate}/sec avg`);
    updateCount = 0;
    lastLogTime = Date.now();
}, 30000);

sendStatus('Level2Worker initialized. Waiting for WebSocket connection...');
