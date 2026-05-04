import { toZonedTime } from 'date-fns-tz';
import * as path from 'path';
import * as fs from 'fs';

/** CME holiday entry from cme-holidays.json */
interface CmeHoliday {
    date: string;          // YYYY-MM-DD
    name: string;
    type: 'CLOSED' | 'EARLY_CLOSE';
    closeTimeET?: string;  // HH:MM format (ET) for early close
}

// Load holidays once at module init
const holidayPath = path.join(__dirname, '..', 'config', 'cme-holidays.json');
let cmeHolidays: CmeHoliday[] = [];
try {
    cmeHolidays = JSON.parse(fs.readFileSync(holidayPath, 'utf-8')) as CmeHoliday[];
} catch (err: any) {
    console.warn(`[MarketClock] ⚠️ Could not load CME holiday calendar: ${err.message}`);
}

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

    // ─────────────────────────────────────────────────────────────────────────
    // MARKET CLOSED DETECTION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Returns true if we're in the CME Globex weekend closure.
     * Globex closes Friday at 5:00 PM ET and reopens Sunday at 5:00 PM ET (actually 6 PM but 5PM is safe).
     *
     * Day 0 = Sunday, 5 = Friday, 6 = Saturday.
     */
    public static isWeekend(timestampMs?: number): boolean {
        const et = MarketClock.getEasternTime(timestampMs);
        const day = et.getDay();   // 0=Sun, 5=Fri, 6=Sat
        const hour = et.getHours();

        // Saturday: always closed
        if (day === 6) return true;

        // Sunday before 6 PM ET: closed
        if (day === 0 && hour < 18) return true;

        // Friday after 5 PM ET: closed
        if (day === 5 && hour >= 17) return true;

        return false;
    }

    /**
     * Returns true during the daily CME Globex maintenance window.
     * Maintenance: 5:00 PM – 6:00 PM ET (Mon-Thu).
     * Friday 5 PM is handled by isWeekend().
     */
    public static isCMEMaintenance(timestampMs?: number): boolean {
        const et = MarketClock.getEasternTime(timestampMs);
        const day = et.getDay();
        const hour = et.getHours();

        // Mon(1) through Thu(4): 5 PM – 6 PM ET is maintenance
        if (day >= 1 && day <= 4 && hour >= 17 && hour < 18) return true;

        return false;
    }

    /**
     * Returns true if today is a CME holiday (fully closed or past early close time).
     * Reads from cme-holidays.json.
     */
    public static isHoliday(timestampMs?: number): boolean {
        const et = MarketClock.getEasternTime(timestampMs);
        const todayStr = `${et.getFullYear()}-${String(et.getMonth() + 1).padStart(2, '0')}-${String(et.getDate()).padStart(2, '0')}`;

        const holiday = cmeHolidays.find(h => h.date === todayStr);
        if (!holiday) return false;

        if (holiday.type === 'CLOSED') return true;

        // EARLY_CLOSE: market is open until the specified time
        if (holiday.type === 'EARLY_CLOSE' && holiday.closeTimeET) {
            const [closeH, closeM] = holiday.closeTimeET.split(':').map(Number);
            const closeMinutes = closeH * 60 + closeM;
            const nowMinutes = et.getHours() * 60 + et.getMinutes();
            return nowMinutes >= closeMinutes;
        }

        return false;
    }

    /**
     * Master check: is the CME Globex session currently closed?
     * Combines weekend, daily maintenance, and holiday checks.
     */
    public static isMarketClosed(timestampMs?: number): boolean {
        return MarketClock.isWeekend(timestampMs)
            || MarketClock.isCMEMaintenance(timestampMs)
            || MarketClock.isHoliday(timestampMs);
    }

    /**
     * Checks if the holiday calendar is about to expire.
     * Returns a warning message if the last holiday entry is within 60 days, null otherwise.
     * Should be called once at startup.
     */
    public static checkHolidayCalendarExpiry(): string | null {
        if (cmeHolidays.length === 0) {
            return '⚠️ CME holiday calendar is EMPTY — update cme-holidays.json';
        }

        const lastDate = new Date(cmeHolidays[cmeHolidays.length - 1].date + 'T00:00:00');
        const now = new Date();
        const daysUntilExpiry = Math.floor((lastDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

        if (daysUntilExpiry < 0) {
            return `⚠️ CME holiday calendar EXPIRED — last entry was ${cmeHolidays[cmeHolidays.length - 1].date}. Update cme-holidays.json`;
        }

        if (daysUntilExpiry < 60) {
            return `⚠️ CME holiday calendar expires in ${daysUntilExpiry} days (last: ${cmeHolidays[cmeHolidays.length - 1].date}). Update cme-holidays.json soon.`;
        }

        return null;
    }
}
