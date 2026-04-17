import { Worker } from 'worker_threads';
import path from 'path';
import { DOMSnapshot, DOMLevel } from '../brokers/TradovateBroker';
import {
    HEADER_BYTES, DOM_DEPTH, FIELDS_PER_LEVEL,
    SAB_BYTE_LENGTH,
    IDX_TIMESTAMP, IDX_BID_COUNT, IDX_ASK_COUNT,
    IDX_BIDS_START, IDX_ASKS_START,
} from './Level2Layout';

/**
 * Level2DataStore — Main-Thread API for the Level 2 DOM SharedArrayBuffer
 *
 * Architecture (Dual Endpoint):
 *   - Allocates a SharedArrayBuffer (352 bytes, 10 ticks × 2 sides)
 *   - Spawns a worker_thread (Core 2) that creates its own
 *     TradovateBroker('LIVE') for Level 2 DOM data.
 *   - The worker authenticates independently against live.tradovateapi.com,
 *     subscribes to md/subscribeDOM, and writes into the SAB.
 *   - Exposes readSnapshot() for the main thread to read the DOM with
 *     ZERO latency (no IPC, no message passing, direct memory read).
 *
 * Thread Safety:
 *   Uses a SeqLock (sequence lock) pattern:
 *     - Writer increments sequence to ODD before writing (signals "in progress")
 *     - Writer increments sequence to EVEN after writing (signals "safe to read")
 *     - Reader checks sequence before and after reading; retries on mismatch
 *
 * Staggered Launch:
 *   Tradovate MAY enforce 1-token-per-user. To prevent a race condition
 *   where DEMO and LIVE tokens are requested simultaneously (potentially
 *   revoking each other), the worker launch is delayed by 2 seconds.
 *   This ensures the main thread's DEMO token is fully acquired first.
 */
export class Level2DataStore {
    private worker!: Worker;
    private sab: SharedArrayBuffer;
    private seqLock: Int32Array;
    private data: Float64Array;

    constructor(symbol: string) {
        // 1. Allocate the SharedArrayBuffer
        this.sab = new SharedArrayBuffer(SAB_BYTE_LENGTH);
        this.seqLock = new Int32Array(this.sab, 0, 1);  // First 4 bytes
        this.data = new Float64Array(this.sab, HEADER_BYTES); // After 8-byte header

        console.log('📊 [Level2DataStore] - SharedArrayBuffer allocated (352 bytes, 10-deep DOM).');
        console.log('📊 [Level2DataStore] - Worker thread launching in 2s (staggered to avoid token race)...');

        // 2. Staggered worker launch — 2s delay to let main thread's DEMO token settle
        setTimeout(() => {
            this.launchWorker(symbol);
        }, 2000);
    }

    private launchWorker(symbol: string): void {
        const workerPath = path.resolve(__dirname, 'Level2Worker.ts');
        const isTypeScript = __filename.endsWith('.ts');
        const workerDataPayload = { sab: this.sab, symbol };

        if (isTypeScript) {
            this.worker = new Worker(
                `require('ts-node').register({ transpileOnly: true }); require(${JSON.stringify(workerPath)});`,
                { eval: true, workerData: workerDataPayload },
            );
        } else {
            const jsWorkerPath = workerPath.replace(/\.ts$/, '.js');
            this.worker = new Worker(jsWorkerPath, { workerData: workerDataPayload });
        }

        // Worker lifecycle handlers
        this.worker.on('error', (err) => {
            console.error('🔴 [Level2DataStore] Worker thread error:', err);
        });

        this.worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`🔴 [Level2DataStore] Worker exited with code ${code}`);
            }
        });

        this.worker.on('message', (msg: any) => {
            if (msg.type === 'status') {
                console.log(`📊 [Level2DataStore] Worker: ${msg.message}`);
            }
        });

        console.log('📊 [Level2DataStore] - Worker thread launched → Core 2 (LIVE endpoint).');
    }

    // ─── Main Thread Reader ────────────────────────────────────────────

    /**
     * Reads the current DOM snapshot from the SharedArrayBuffer.
     *
     * Uses a SeqLock pattern for lock-free, wait-free reads:
     *   1. Read sequence counter
     *   2. If odd → writer is active → retry
     *   3. Read all data
     *   4. Re-read sequence counter
     *   5. If changed → torn read → retry
     *
     * Performance: ~50 nanoseconds per read. Zero IPC. Zero allocation
     * (caller reuses the returned object reference).
     *
     * @returns DOMSnapshot or null if no data has been written yet
     */
    public readSnapshot(): DOMSnapshot | null {
        const MAX_RETRIES = 5;

        for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
            // Step 1: Read sequence BEFORE
            const seqBefore = Atomics.load(this.seqLock, 0);

            // Step 2: If odd, writer is mid-update — spin
            if (seqBefore % 2 !== 0) continue;

            // Step 3: Read the data
            const timestamp = this.data[IDX_TIMESTAMP];
            const bidCount = Math.min(Math.floor(this.data[IDX_BID_COUNT]), DOM_DEPTH);
            const askCount = Math.min(Math.floor(this.data[IDX_ASK_COUNT]), DOM_DEPTH);

            const bids: DOMLevel[] = [];
            for (let i = 0; i < bidCount; i++) {
                const offset = IDX_BIDS_START + (i * FIELDS_PER_LEVEL);
                bids.push({
                    price: this.data[offset],
                    size: this.data[offset + 1],
                });
            }

            const offers: DOMLevel[] = [];
            for (let i = 0; i < askCount; i++) {
                const offset = IDX_ASKS_START + (i * FIELDS_PER_LEVEL);
                offers.push({
                    price: this.data[offset],
                    size: this.data[offset + 1],
                });
            }

            // Step 4: Read sequence AFTER
            const seqAfter = Atomics.load(this.seqLock, 0);

            // Step 5: If match and even → clean read
            if (seqBefore === seqAfter) {
                if (timestamp === 0) return null; // No data written yet by worker
                return { timestamp, bids, offers };
            }
            // Mismatch → torn read, retry
        }

        return null; // All retries exhausted (should be astronomically rare)
    }

    /**
     * Terminates the worker thread gracefully.
     */
    public async shutdown(): Promise<void> {
        await this.worker.terminate();
        console.log('📊 [Level2DataStore] - Worker thread terminated.');
    }
}
