/**
 * Level2Worker — Dedicated Worker Thread for Tradovate Level 2 DOM Ingestion
 *
 * Thread Assignment: Core 2
 *
 * This worker runs in its own V8 isolate (worker_thread) to keep the
 * CME Globex Level 2 firehose completely off the main thread's event loop.
 *
 * Lifecycle:
 *   1. Receives SharedArrayBuffer + auth credentials via workerData
 *   2. Opens its own WebSocket to wss://md.tradovateapi.com/v1/websocket
 *   3. Authenticates with the access token
 *   4. Subscribes to md/subscribeDOM for the target symbol
 *   5. On every md/dom event, writes bid/ask data into the SAB using SeqLock
 *   6. Main thread reads the SAB at any time with zero latency
 *
 * The worker sends status messages to the main thread via parentPort
 * for lifecycle logging (connected, subscribed, errors).
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

/**
 * Writes a DOM snapshot into the SharedArrayBuffer using the SeqLock protocol.
 *
 * SeqLock Write Sequence:
 *   1. Increment sequence to ODD (signals "write in progress")
 *   2. Write all DOM data to the Float64Array
 *   3. Increment sequence to EVEN (signals "write complete, safe to read")
 *
 * This guarantees the reader always sees a consistent snapshot.
 */
function writeDOMToSAB(bids: { price: number; size: number }[], offers: { price: number; size: number }[]): void {
    const bidCount = Math.min(bids.length, DOM_DEPTH);
    const askCount = Math.min(offers.length, DOM_DEPTH);

    // Step 1: Signal write-in-progress (odd sequence)
    Atomics.add(seqLock, 0, 1);

    // Step 2: Write the data
    data[IDX_TIMESTAMP] = Date.now();
    data[IDX_BID_COUNT] = bidCount;
    data[IDX_ASK_COUNT] = askCount;

    // Write bids (sorted best-first by the broker)
    for (let i = 0; i < bidCount; i++) {
        const offset = IDX_BIDS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = bids[i].price;
        data[offset + 1] = bids[i].size;
    }
    // Zero out unused bid slots
    for (let i = bidCount; i < DOM_DEPTH; i++) {
        const offset = IDX_BIDS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = 0;
        data[offset + 1] = 0;
    }

    // Write offers (sorted best-first by the broker)
    for (let i = 0; i < askCount; i++) {
        const offset = IDX_ASKS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = offers[i].price;
        data[offset + 1] = offers[i].size;
    }
    // Zero out unused offer slots
    for (let i = askCount; i < DOM_DEPTH; i++) {
        const offset = IDX_ASKS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = 0;
        data[offset + 1] = 0;
    }

    // Step 3: Signal write-complete (even sequence)
    Atomics.add(seqLock, 0, 1);

    updateCount++;
}

/**
 * Sorts bids descending (highest price first) and offers ascending (lowest price first).
 */
function sortBids(arr: { price: number; size: number }[]): { price: number; size: number }[] {
    return arr.sort((a, b) => b.price - a.price);
}

function sortOffers(arr: { price: number; size: number }[]): { price: number; size: number }[] {
    return arr.sort((a, b) => a.price - b.price);
}

// ─── Status Reporter ───────────────────────────────────────────────
function sendStatus(message: string): void {
    parentPort?.postMessage({ type: 'status', message });
}

// ─── WebSocket Connection ──────────────────────────────────────────

sendStatus(`Connecting to ${mdUrl}...`);

const ws = new WebSocket(mdUrl);

ws.on('open', () => {
    sendStatus('WebSocket connected. Authenticating...');

    // Authenticate using the access token from the main thread
    ws.send(`authorize\n1\n\n${accessToken}`);

    // Subscribe to DOM after a short delay to ensure auth is processed
    setTimeout(() => {
        sendStatus(`Subscribing to md/subscribeDOM for ${symbol}...`);
        ws.send(`md/subscribeDOM\n2\n\n{"symbol":"${symbol}"}`);
        sendStatus(`Level 2 DOM subscription active for ${symbol}. Writing to SAB.`);
    }, 500);

    // Keep-alive heartbeat (matches main thread's 2.5s interval)
    setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send('[]');
        }
    }, 2500);
});

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

ws.on('error', (err: Error) => {
    sendStatus(`🔴 WebSocket error: ${err.message}`);
});

ws.on('close', (code: number, reason: Buffer) => {
    sendStatus(`WebSocket closed. Code: ${code}, Reason: ${reason.toString()}`);
});

// ─── Periodic Throughput Logger ────────────────────────────────────
// Logs SAB write throughput every 30 seconds for operational monitoring
setInterval(() => {
    const elapsed = (Date.now() - lastLogTime) / 1000;
    const rate = Math.round(updateCount / elapsed);
    sendStatus(`SAB writes: ${updateCount} total | ${rate}/sec avg`);
    updateCount = 0;
    lastLogTime = Date.now();
}, 30000);
