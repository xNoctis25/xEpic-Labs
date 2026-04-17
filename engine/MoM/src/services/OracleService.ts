import { Worker } from 'worker_threads';
import path from 'path';

/**
 * OracleService — Main-Thread Interface for the Oracle Worker (Core 3)
 *
 * Architecture (Phase 4: Oracle Isolation):
 *   Previously, the Oracle ran all FMP API fetching, cron scheduling, and
 *   blockout calculation on the Main Thread. Now, all heavy logic lives
 *   in OracleWorker.ts (worker_thread on Core 3).
 *
 *   This class is a thin proxy:
 *     - Spawns OracleWorker on construction
 *     - Listens for BLOCKOUT_STATUS messages and caches the boolean
 *     - isNewsBlockoutActive() reads the cached boolean (synchronous, ~0ns)
 *     - fetchTodaysEvents() sends FETCH_NOW to worker and awaits response
 *     - startScheduler() sends START_SCHEDULER to worker
 *
 *   The main thread event loop (Core 1) is completely free of API I/O.
 */
export class OracleService {
    private worker: Worker;

    // ─── Cached State (updated by worker messages) ─────────────────
    private _isBlockoutActive: boolean = false;
    private _eventCount: number = 0;
    private _nextEvent: { timestampMs: number; minutesUntil: number } | null = null;

    // ─── Preflight Awaiter ─────────────────────────────────────────
    // fetchTodaysEvents() resolves when the worker completes its first fetch
    private fetchResolve: (() => void) | null = null;

    constructor() {
        const apiKey = (process.env.ORACLE_API_KEY || '').trim();

        if (!apiKey) {
            console.error('🔴 [Oracle] - ORACLE_API_KEY not found in .env. News filter will be disabled.');
        }

        // Spawn the OracleWorker on Core 3
        const workerPath = path.resolve(__dirname, 'OracleWorker.ts');
        const isTypeScript = __filename.endsWith('.ts');

        if (isTypeScript) {
            this.worker = new Worker(
                `require('ts-node').register({ transpileOnly: true }); require(${JSON.stringify(workerPath)});`,
                {
                    eval: true,
                    workerData: { apiKey },
                },
            );
        } else {
            const jsWorkerPath = workerPath.replace(/\.ts$/, '.js');
            this.worker = new Worker(jsWorkerPath, {
                workerData: { apiKey },
            });
        }

        // ─── Message Handler (Worker → Main) ───────────────────────
        this.worker.on('message', (msg: any) => {
            switch (msg.type) {
                case 'BLOCKOUT_STATUS':
                    this._isBlockoutActive = msg.isActive;
                    this._eventCount = msg.eventCount;
                    this._nextEvent = msg.nextEvent;
                    break;

                case 'FETCH_COMPLETE':
                    this._eventCount = msg.eventCount;
                    if (msg.events && msg.events.length > 0) {
                        console.log(`🔮 [Oracle] - ${msg.eventCount} high-impact US event(s) cached:`);
                        msg.events.forEach((desc: string) => {
                            console.log(`   🔴 ${desc}`);
                        });
                    } else {
                        console.log('🔮 [Oracle] - No high-impact US events today. Clear skies. ✅');
                    }
                    // Resolve the preflight awaiter if pending
                    if (this.fetchResolve) {
                        this.fetchResolve();
                        this.fetchResolve = null;
                    }
                    break;

                case 'STATUS':
                    console.log(`🔮 [Oracle] - ${msg.message}`);
                    break;

                case 'ERROR':
                    console.error(`🔴 [Oracle] - ${msg.message}`);
                    // Still resolve preflight so it doesn't hang
                    if (this.fetchResolve) {
                        this.fetchResolve();
                        this.fetchResolve = null;
                    }
                    break;
            }
        });

        this.worker.on('error', (err) => {
            console.error('🔴 [Oracle] - Worker thread error:', err);
        });

        this.worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`🔴 [Oracle] - Worker exited with code ${code}`);
            }
        });
    }

    // ─── Preflight: Fetch Today's Events ───────────────────────────
    /**
     * Sends FETCH_NOW to the worker and waits for FETCH_COMPLETE.
     * Used by MoMEngine.runPreflightCheck() to ensure the cache is
     * populated before trading begins.
     */
    public async fetchTodaysEvents(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.fetchResolve = resolve;
            this.worker.postMessage({ type: 'FETCH_NOW' });
        });
    }

    // ─── Synchronous Blockout Check (Gate 1) ───────────────────────
    /**
     * SYNCHRONOUS check against the cached boolean pushed by the worker.
     * The worker polls the blockout status every 5 seconds and pushes
     * updates via parentPort.postMessage().
     *
     * Performance: Direct boolean read — effectively 0 nanoseconds.
     * The timestamp parameter is accepted for backward compatibility
     * but is not used (the worker calculates against Date.now()).
     */
    public isNewsBlockoutActive(_currentTimestampMs: number): boolean {
        return this._isBlockoutActive;
    }

    // ─── Scheduler ─────────────────────────────────────────────────
    /**
     * Tells the worker to start the 08:00 ET cron scheduler and
     * the 5-second blockout status polling loop.
     */
    public async startScheduler(): Promise<void> {
        this.worker.postMessage({ type: 'START_SCHEDULER' });
    }

    // ─── Diagnostics ───────────────────────────────────────────────

    /**
     * Returns the next upcoming event (cached from worker updates).
     */
    public getNextEvent(_currentTimestampMs: number): { timestampMs: number; minutesUntil: number } | null {
        return this._nextEvent;
    }

    /**
     * Returns the number of cached events.
     */
    public getCachedEventCount(): number {
        return this._eventCount;
    }
}
