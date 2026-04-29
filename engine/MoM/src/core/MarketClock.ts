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
     * Returns true if the given timestamp falls within the AM Killzone (Equities Open).
     * AM Killzone: 09:45 – 11:30 ET (inclusive)
     * Features a 15-minute "Silver Bullet" buffer to avoid the 9:30 AM opening liquidity sweep.
     *
     * @param timestampMs - UNIX epoch in milliseconds
     */
    public static isAMKillzone(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);
        return totalMinutes >= 585 && totalMinutes <= 690; // 09:45 (585) – 11:30 (690)
    }

    /**
     * Returns true if the given timestamp falls within the PM Killzone.
     * PM Killzone: 13:30 – 15:45 ET (inclusive)
     * Cuts off 15 minutes before the 4:00 PM close to avoid MOC (Market On Close) imbalances.
     *
     * @param timestampMs - UNIX epoch in milliseconds
     */
    public static isPMKillzone(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);
        return totalMinutes >= 810 && totalMinutes <= 945; // 13:30 (810) – 15:45 (945)
    }

    /**
     * Returns true if the given timestamp falls within one of the three strict SMC Killzones.
     * Features 15-minute opening buffers for London and NY AM to avoid Judas Swings.
     */
    public static isWithinTradingWindow(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);

        // London Killzone: 02:15 ET (135) to 05:00 ET (300) -> 15 min buffer
        const isLondon = totalMinutes >= 135 && totalMinutes < 300;

        // AM Killzone: 09:45 ET (585) to 11:30 ET (690) -> 15 min buffer
        const isAM = totalMinutes >= 585 && totalMinutes < 690;

        // PM Killzone: 13:30 ET (810) to 15:45 ET (945) -> No buffer needed, early cutoff
        const isPM = totalMinutes >= 810 && totalMinutes < 945;

        return isLondon || isAM || isPM;
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
