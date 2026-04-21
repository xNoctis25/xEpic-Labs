import { toZonedTime } from 'date-fns-tz';

/**
 * MarketClock — Eastern Atomic Clock
 *
 * All temporal logic in M.o.M is strictly pegged to "America/New_York" (ET).
 * This utility converts any UNIX epoch timestamp into ET, regardless of the
 * host server's local timezone (UTC on cloud, EST/EDT on local dev).
 *
 * Used by: BacktestEngine, MoMEngine, OracleService, EvaluationEngine
 */
const EASTERN_TZ = 'America/New_York';

export class MarketClock {
    /**
     * Converts a UNIX epoch timestamp (or current time) into an Eastern Time Date object.
     * The returned Date's getHours()/getMinutes() methods will reflect ET values.
     *
     * @param timestampMs - UNIX epoch in milliseconds (defaults to Date.now())
     * @returns A Date object representing Eastern Time
     */
    public static getEasternTime(timestampMs?: number): Date {
        const utcDate = timestampMs ? new Date(timestampMs) : new Date();
        return toZonedTime(utcDate, EASTERN_TZ);
    }

    /**
     * Extracts hour and minute in ET from a UNIX epoch timestamp.
     * Returns { hour: 0-23, minute: 0-59, totalMinutes: 0-1439 }
     */
    public static getEasternHM(timestampMs?: number): { hour: number; minute: number; totalMinutes: number } {
        const et = MarketClock.getEasternTime(timestampMs);
        const hour = et.getHours();
        const minute = et.getMinutes();
        return { hour, minute, totalMinutes: hour * 60 + minute };
    }

    /**
     * Returns true if the given timestamp falls within the AM Killzone (Silver Bullet).
     * AM Killzone: 09:30 – 11:00 ET (inclusive)
     *
     * @param timestampMs - UNIX epoch in milliseconds
     */
    public static isAMKillzone(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);
        return totalMinutes >= 570 && totalMinutes <= 660; // 09:30 (570) – 11:00 (660)
    }

    /**
     * Returns true if the given timestamp falls within the EOD flatten window.
     * Used to force-close any open positions before the market close.
     *
     * ONLY triggers strictly between 15:55 and 15:59 ET.
     * Once 16:00 hits, this returns false and stops the sweep.
     *
     * @param timestamp - UNIX epoch in milliseconds
     */
    public static isEndOfDayFlatten(timestamp: number): boolean {
        const date = new Date(timestamp);
        const estDate = new Date(date.toLocaleString("en-US", { timeZone: "America/New_York" }));
        const hour = estDate.getHours();
        const minute = estDate.getMinutes();

        // ONLY trigger the rolling sweeper strictly between 15:55 and 15:59 ET.
        // Once 16:00 hits, this returns false and stops the sweep.
        return hour === 15 && minute >= 55;
    }

    /**
     * Returns a formatted time string in ET for logging.
     * Example: "09:30 AM", "03:55 PM"
     */
    public static formatET(timestampMs?: number): string {
        const et = MarketClock.getEasternTime(timestampMs);
        return et.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true,
        });
    }

    /**
     * Returns the current Eastern Time date string (YYYY-MM-DD).
     */
    public static getTodayET(): string {
        const et = MarketClock.getEasternTime();
        const y = et.getFullYear();
        const m = String(et.getMonth() + 1).padStart(2, '0');
        const d = String(et.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
}
