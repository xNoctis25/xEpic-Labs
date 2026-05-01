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
     * AM Killzone: 09:30 – 11:30 ET (inclusive)
     * The 9:30 AM open is the highest-probability window — NO blanket buffer.
     * Use isOpeningDrive() for special Judas Swing confirmation during the first 5 minutes.
     *
     * @param timestampMs - UNIX epoch in milliseconds
     */
    public static isAMKillzone(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);
        return totalMinutes >= 570 && totalMinutes <= 690; // 09:30 (570) – 11:30 (690)
    }

    /**
     * Returns true if the given timestamp falls within the PM Killzone.
     * PM Killzone: 13:30 – 16:15 ET (inclusive)
     * Cuts off 30 minutes before the 16:45 EOD flatten to avoid late entries.
     *
     * @param timestampMs - UNIX epoch in milliseconds
     */
    public static isPMKillzone(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);
        return totalMinutes >= 810 && totalMinutes <= 975; // 13:30 (810) – 16:15 (975)
    }

    /**
     * Returns true if the given timestamp falls within one of the three strict SMC Killzones.
     * Features 15-minute opening buffers for London and NY AM to avoid Judas Swings.
     */
    public static isWithinTradingWindow(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);

        // London Killzone: 02:15 ET (135) to 05:00 ET (300) -> 15 min buffer
        const isLondon = totalMinutes >= 135 && totalMinutes < 300;

        // AM Killzone: 09:30 ET (570) to 11:30 ET (690) -> NO buffer (open is prime time)
        const isAM = totalMinutes >= 570 && totalMinutes < 690;

        // PM Killzone: 13:30 ET (810) to 16:15 ET (975) -> 30min before EOD flatten
        const isPM = totalMinutes >= 810 && totalMinutes < 975;

        return isLondon || isAM || isPM;
    }

    /**
     * Returns true during the first 5 minutes of the US open (09:30 – 09:35 ET).
     * During this window, MomWorker should apply Judas Swing confirmation:
     * Wait for the 2nd 1-min candle to close in the same direction as the 1st
     * before firing a trade, confirming the opening drive is real.
     */
    public static isOpeningDrive(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);
        return totalMinutes >= 570 && totalMinutes < 575; // 09:30 – 09:35 ET
    }

    /**
     * Returns true if the CME futures session is open: 09:30–17:00 ET.
     * Used to define the outer boundary of the "Wilderness" zone.
     * Note: Tradovate session close is 17:00 ET. Intraday margin ends at 16:45 ET.
     */
    public static isMarketOpen(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);
        return totalMinutes >= 570 && totalMinutes < 1020; // 09:30 (570) – 17:00 (1020)
    }

    /**
     * "The Wilderness" — market is open but outside all three Killzones.
     * Trades entered here carry significantly higher structural risk.
     * MoM enforces Short Leash parameters when in the Wilderness.
     */
    public static isWilderness(timestampMs: number): boolean {
        return MarketClock.isMarketOpen(timestampMs) && !MarketClock.isWithinTradingWindow(timestampMs);
    }

    /**
     * Returns true if the given timestamp falls within the EOD flatten window.
     * Used to force-close any open positions before Tradovate's margin deadline.
     *
     * Tradovate auto-liquidates at 16:45 ET (15 min before 17:00 session close).
     * We flatten at 16:30 ET — giving us a 15-minute buffer before their auto-liquidation.
     *
     * Triggers between 16:30 and 16:44 ET.
     * Once 16:45 hits, this returns false (Tradovate takes over).
     *
     * @param timestamp - UNIX epoch in milliseconds
     */
    public static isEndOfDayFlatten(timestamp: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestamp);
        return totalMinutes >= 990 && totalMinutes < 1005; // 16:30 (990) – 16:44 (1004)
    }

    /**
     * Hard entry cutoff — no new trades after 16:15 ET.
     * Gives 15 min of breathing room before EOD flatten at 16:30.
     */
    public static isPastEntryCutoff(timestampMs: number): boolean {
        const { totalMinutes } = MarketClock.getEasternHM(timestampMs);
        return totalMinutes >= 975; // 16:15 ET
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
