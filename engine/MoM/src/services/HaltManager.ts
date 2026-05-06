import { NeonDatabase } from './NeonDatabase';
import { getNextCmeOpen } from '../utils/TimeUtils';

export type HaltType = 'DAILY_PROFIT' | 'CHALLENGE_PASSED' | 'MANUAL_HALT';

export class HaltManager {
    private db: NeonDatabase;
    private halted: boolean = false;
    private activeHaltType: string | null = null;
    private unlockTime: Date | null = null;
    private checkTimer: ReturnType<typeof setInterval> | null = null;
    private onStateChangeCb: ((isHalted: boolean, haltType?: string) => void) | null = null;

    constructor(db: NeonDatabase) {
        this.db = db;
    }

    /**
     * Boot Sync. Checks the database for any active halts.
     * If an active halt is expired, NeonDB will automatically resolve it.
     */
    public async initialize(): Promise<void> {
        const activeHalt = await this.db.getActiveHalt();
        if (activeHalt) {
            this.halted = true;
            this.activeHaltType = activeHalt.haltType;
            this.unlockTime = activeHalt.unlockTime;
            console.log(`🛑 [HaltManager] - Booted in HALT state (${this.activeHaltType}). Unlocks: ${this.unlockTime ? this.unlockTime.toLocaleString('en-US', {timeZone: 'America/New_York'}) : 'MANUAL_RESET'}`);
        }

        // Start background poll to automatically release time-based halts
        this.startPoll();
    }

    public onStateChange(cb: (isHalted: boolean, haltType?: string) => void) {
        this.onStateChangeCb = cb;
    }

    /**
     * Fast, synchronous check used in the hot-path before taking a trade.
     */
    public isHalted(): boolean {
        return this.halted;
    }

    /**
     * Instantly blocks execution and persists the halt to the database.
     */
    public async triggerHalt(type: HaltType, unlockTime?: Date): Promise<void> {
        if (this.halted) return; // Already halted
        
        this.halted = true;
        this.activeHaltType = type;
        this.unlockTime = unlockTime || null;

        await this.db.createHalt(type, unlockTime);
        if (this.onStateChangeCb) this.onStateChangeCb(true, type);
    }

    /**
     * Resolves all halts globally and frees the engine.
     */
    public async resolveHalt(): Promise<void> {
        if (!this.halted) return;

        this.halted = false;
        this.activeHaltType = null;
        this.unlockTime = null;

        await this.db.resolveHalt();
        if (this.onStateChangeCb) this.onStateChangeCb(false);
    }

    /**
     * Background cron to actively poll the DB every 5 seconds.
     * This allows the running engine to instantly detect manual halts inserted by external scripts.
     */
    private startPoll() {
        this.checkTimer = setInterval(async () => {
            try {
                const activeHalt = await this.db.getActiveHalt();

                if (activeHalt) {
                    // Check if the current halt has expired
                    if (activeHalt.unlockTime && new Date() >= new Date(activeHalt.unlockTime)) {
                        console.log(`⏰ [HaltManager] - Unlock time reached for ${activeHalt.haltType}. Releasing engine.`);
                        await this.resolveHalt();
                        return;
                    }

                    // If a new halt was inserted externally
                    if (!this.halted) {
                        this.halted = true;
                        this.activeHaltType = activeHalt.haltType;
                        this.unlockTime = activeHalt.unlockTime;
                        console.log(`🚨 [HaltManager] - EXTERNAL HALT DETECTED: ${this.activeHaltType}`);
                        if (this.onStateChangeCb) this.onStateChangeCb(true, this.activeHaltType);
                    }
                } else {
                    // If an existing halt was resolved externally
                    if (this.halted) {
                        this.halted = false;
                        this.activeHaltType = null;
                        this.unlockTime = null;
                        console.log(`🟢 [HaltManager] - EXTERNAL UNHALT DETECTED. Engine is live.`);
                        if (this.onStateChangeCb) this.onStateChangeCb(false);
                    }
                }
            } catch (err: any) {
                // silent fail on DB poll error
            }
        }, 5000); // Check every 5 seconds
    }

    public stopPoll() {
        if (this.checkTimer) clearInterval(this.checkTimer);
    }
}
