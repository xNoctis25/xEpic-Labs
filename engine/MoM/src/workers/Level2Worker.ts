/**
 * Level2Worker — Dedicated Worker Thread for Tradovate Level 2 DOM Ingestion
 *
 * Thread Assignment: Core 2
 *
 * Dual Endpoint Architecture:
 *   This worker creates its own TradovateBroker('LIVE') instance to
 *   authenticate against live.tradovateapi.com — ensuring full Level 2
 *   data entitlements regardless of the main thread's DEMO endpoint.
 *   Uses the same universal credentials, just a different API endpoint.
 *
 * Staggered Launch:
 *   Level2DataStore delays worker creation by 2 seconds to ensure the
 *   main thread's DEMO token is fully acquired before we request a
 *   LIVE token. This prevents simultaneous token requests from
 *   revoking each other.
 *
 * Lifecycle:
 *   1. Receives SharedArrayBuffer + symbol via workerData
 *   2. Creates TradovateBroker('LIVE') and calls connect() (own OAuth + WebSocket)
 *   3. Subscribes to md/subscribeDOM via the broker's API
 *   4. On every DOMSnapshot callback, writes bid/ask data into the SAB using SeqLock
 *   5. Main thread reads the SAB at any time with zero latency
 */

import { workerData, parentPort } from 'worker_threads';
import { TradovateBroker, DOMSnapshot } from '../brokers/TradovateBroker';
import {
    HEADER_BYTES, DOM_DEPTH, FIELDS_PER_LEVEL,
    IDX_TIMESTAMP, IDX_BID_COUNT, IDX_ASK_COUNT,
    IDX_BIDS_START, IDX_ASKS_START,
} from './Level2Layout';

// ─── Worker Data from Main Thread ──────────────────────────────────
const { sab, symbol } = workerData as {
    sab: SharedArrayBuffer;
    symbol: string;
};

// ─── Shared Memory Views ───────────────────────────────────────────
const seqLock = new Int32Array(sab, 0, 1);   // SeqLock counter (bytes 0-3)
const data = new Float64Array(sab, HEADER_BYTES); // DOM data (bytes 8+)

// ─── Metrics ───────────────────────────────────────────────────────
let updateCount = 0;
let lastLogTime = Date.now();

/**
 * Writes a DOM snapshot into the SharedArrayBuffer using the SeqLock protocol.
 */
function writeDOMToSAB(snapshot: DOMSnapshot): void {
    const bidCount = Math.min(snapshot.bids.length, DOM_DEPTH);
    const askCount = Math.min(snapshot.offers.length, DOM_DEPTH);

    // Step 1: Signal write-in-progress (odd sequence)
    Atomics.add(seqLock, 0, 1);

    // Step 2: Write the data
    data[IDX_TIMESTAMP] = Date.now();
    data[IDX_BID_COUNT] = bidCount;
    data[IDX_ASK_COUNT] = askCount;

    for (let i = 0; i < bidCount; i++) {
        const offset = IDX_BIDS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = snapshot.bids[i].price;
        data[offset + 1] = snapshot.bids[i].size;
    }
    for (let i = bidCount; i < DOM_DEPTH; i++) {
        const offset = IDX_BIDS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = 0;
        data[offset + 1] = 0;
    }

    for (let i = 0; i < askCount; i++) {
        const offset = IDX_ASKS_START + (i * FIELDS_PER_LEVEL);
        data[offset]     = snapshot.offers[i].price;
        data[offset + 1] = snapshot.offers[i].size;
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

// ─── Status Reporter ───────────────────────────────────────────────
function sendStatus(message: string): void {
    parentPort?.postMessage({ type: 'status', message });
}

// ─── Boot: Create LIVE Broker + Connect + Subscribe ────────────────

async function init(): Promise<void> {
    sendStatus('Creating TradovateBroker(LIVE) for Level 2 data...');

    const broker = new TradovateBroker('LIVE');

    sendStatus('Connecting LIVE broker (OAuth + WebSocket)...');
    const connected = await broker.connect();

    if (!connected) {
        sendStatus('🔴 LIVE broker connection FAILED. DOM data will not flow.');
        return;
    }

    sendStatus(`LIVE broker connected. Subscribing to DOM for ${symbol}...`);

    broker.subscribeDOMData(symbol, (snapshot: DOMSnapshot) => {
        writeDOMToSAB(snapshot);
    });

    sendStatus(`Level 2 DOM subscription active for ${symbol}. Writing to SAB.`);
}

init().catch((err) => {
    sendStatus(`🔴 Worker init failed: ${err.message}`);
});

// ─── Periodic Throughput Logger ────────────────────────────────────
setInterval(() => {
    const elapsed = (Date.now() - lastLogTime) / 1000;
    const rate = Math.round(updateCount / elapsed);
    sendStatus(`SAB writes: ${updateCount} total | ${rate}/sec avg`);
    updateCount = 0;
    lastLogTime = Date.now();
}, 30000);
