import axios from 'axios';
import cron from 'node-cron';

/**
 * OracleService — Macroeconomic News Blackout Filter
 *
 * Architecture: "Pre-Fetch and Cache"
 *   1. Daily at 08:00 ET, fetches today's high-impact US economic events from FMP.
 *   2. Caches event timestamps in a local array (pure RAM).
 *   3. isNewsBlockoutActive() is a synchronous, sub-millisecond check against the cache.
 *
 * Blackout Window: ±15 minutes around each high-impact event.
 */
export class OracleService {
    private cachedEventTimestamps: number[] = [];
    private readonly BLOCKOUT_WINDOW_MS = 15 * 60 * 1000; // ±15 minutes
    private readonly apiKey: string;

    constructor() {
        const key = process.env.ORACLE_API_KEY;
        if (!key) {
            console.error('🔴 [Oracle] - ORACLE_API_KEY not found in .env. News filter will be disabled.');
        }
        this.apiKey = (key || '').trim();
    }

    // ==========================================
    // Step 1: Daily Pre-Fetch
    // ==========================================
    /**
     * Fetches today's high-impact US economic events from the FMP Economic Calendar API.
     * Filters for country === "US" AND impact === "High".
     * Stores only the timestamps in a flat in-memory array for O(n) access.
     */
    public async fetchTodaysEvents(): Promise<void> {
        if (!this.apiKey) {
            console.warn('⚠️ [Oracle] - No API key. Skipping news fetch.');
            return;
        }

        const today = new Date();
        const dateStr = today.toISOString().split('T')[0]; // YYYY-MM-DD

        try {
            console.log(`🔮 [Oracle] - Fetching economic calendar for ${dateStr}...`);

            const url = `https://financialmodelingprep.com/api/v3/economic_calendar?from=${dateStr}&to=${dateStr}&apikey=${this.apiKey}`;
            const response = await axios.get(url, {
                headers: {},          // Ensure no default Authorization header leaks through
                timeout: 10000,       // 10-second timeout
            });

            const events: any[] = response.data || [];

            // Filter: US-only + High-impact events
            const highImpactUS = events.filter((event: any) => {
                const isUS = event.country === 'US' || event.currency === 'USD';
                const isHigh = (event.impact || '').toLowerCase() === 'high';
                return isUS && isHigh;
            });

            // Extract and cache timestamps
            this.cachedEventTimestamps = highImpactUS
                .map((event: any) => {
                    // FMP returns date as ISO string (e.g., "2026-04-16 08:30:00")
                    const ts = new Date(event.date).getTime();
                    return isNaN(ts) ? null : ts;
                })
                .filter((ts): ts is number => ts !== null);

            if (this.cachedEventTimestamps.length > 0) {
                console.log(`🔮 [Oracle] - ${this.cachedEventTimestamps.length} high-impact US event(s) cached:`);
                highImpactUS.forEach((event: any) => {
                    console.log(`   🔴 ${event.event} @ ${event.date} (Impact: ${event.impact})`);
                });
            } else {
                console.log('🔮 [Oracle] - No high-impact US events today. Clear skies. ✅');
            }

        } catch (error: any) {
            console.error('🔴 [Oracle] - Failed to fetch economic calendar:', error.message);
            // On failure, keep the existing cache (stale is better than empty)
        }
    }

    // ==========================================
    // Step 2: Sub-Millisecond Blockout Check
    // ==========================================
    /**
     * SYNCHRONOUS check against the local RAM cache.
     * Returns true if the given timestamp falls within ±15 minutes of any cached event.
     *
     * Performance: O(n) where n = number of high-impact events per day (typically 0-3).
     * Executes in nanoseconds — zero network I/O, zero blocking.
     */
    public isNewsBlockoutActive(currentTimestampMs: number): boolean {
        for (let i = 0; i < this.cachedEventTimestamps.length; i++) {
            const eventTs = this.cachedEventTimestamps[i];
            const diff = Math.abs(currentTimestampMs - eventTs);
            if (diff <= this.BLOCKOUT_WINDOW_MS) {
                return true; // Inside a ±15 min blackout window
            }
        }
        return false;
    }

    /**
     * Returns the next upcoming blackout event for logging purposes.
     * Returns null if no events remain today.
     */
    public getNextEvent(currentTimestampMs: number): { timestampMs: number; minutesUntil: number } | null {
        let closest: number | null = null;
        let minDiff = Infinity;

        for (const eventTs of this.cachedEventTimestamps) {
            const diff = eventTs - currentTimestampMs;
            if (diff > 0 && diff < minDiff) {
                minDiff = diff;
                closest = eventTs;
            }
        }

        if (closest === null) return null;
        return {
            timestampMs: closest,
            minutesUntil: Math.round(minDiff / 60000),
        };
    }

    // ==========================================
    // Step 3: Cron Scheduler (08:00 ET Daily)
    // ==========================================
    /**
     * Schedules the daily pre-fetch at 08:00 AM ET (before the AM Killzone opens at 09:30).
     * Also performs an immediate fetch on startup to populate the cache.
     */
    public async startScheduler(): Promise<void> {
        // Immediate fetch on boot so the cache is populated right away
        await this.fetchTodaysEvents();

        // Schedule daily refresh at 08:00 AM ET
        // Cron format: minute hour * * * (runs in system timezone)
        // We use America/New_York timezone to ensure it's always 08:00 ET
        cron.schedule('0 8 * * *', async () => {
            console.log('🔮 [Oracle] - Daily 08:00 ET refresh triggered.');
            await this.fetchTodaysEvents();
        }, {
            timezone: 'America/New_York',
        });

        console.log('🔮 [Oracle] - Cron scheduler active. Daily refresh at 08:00 AM ET.');
    }

    /**
     * Returns the number of cached events (for diagnostics).
     */
    public getCachedEventCount(): number {
        return this.cachedEventTimestamps.length;
    }
}
