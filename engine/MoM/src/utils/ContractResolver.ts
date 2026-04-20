import { MarketClock } from '../core/MarketClock';

/**
 * ContractResolver — Automated CME Front-Month Contract Rollover
 *
 * Calculates the active CME equity index front-month contract symbol
 * based on the current date with automatic rollover logic.
 *
 * CME Quarterly Expiration Months:
 *   H = March  |  M = June  |  U = September  |  Z = December
 *
 * Roll Rule:
 *   Rollover occurs on the 2nd Thursday of the expiration month
 *   (~8 days before the 3rd Friday expiration). On or after the
 *   roll date, the NEXT quarter's contract becomes active.
 *
 * Output format: Tradovate symbol (e.g., 'MESM6' for June 2026)
 */
export class ContractResolver {
    private static readonly QUARTER_CODES = ['H', 'M', 'U', 'Z'] as const;
    private static readonly QUARTER_MONTHS = [2, 5, 8, 11] as const; // 0-indexed: Mar, Jun, Sep, Dec

    /**
     * Finds the 2nd Thursday of a given month/year.
     *
     * Algorithm:
     *   1. Start on the 1st of the month.
     *   2. Find the first Thursday (day-of-week 4).
     *   3. Add 7 days to reach the 2nd Thursday.
     *
     * @param year  - Full year (e.g. 2026)
     * @param month - 0-indexed month (e.g. 2 = March)
     * @returns The day-of-month of the 2nd Thursday
     */
    private static getSecondThursday(year: number, month: number): number {
        const firstOfMonth = MarketClock.getEasternTime(
            new Date(year, month, 1).getTime()
        );
        const dayOfWeek = firstOfMonth.getDay(); // 0=Sun, 4=Thu

        // Days until the first Thursday
        const daysUntilFirstThursday = (4 - dayOfWeek + 7) % 7;
        const firstThursday = 1 + daysUntilFirstThursday;
        const secondThursday = firstThursday + 7;

        return secondThursday;
    }

    /**
     * Returns the active CME front-month contract symbol for the given root.
     *
     * @param baseSymbol - The product root (default: 'MES')
     * @returns Full Tradovate contract symbol (e.g., 'MESM6' for June 2026)
     *
     * Examples (2026):
     *   Jan 15   → 'MESH6'  (March 2026 — no roll yet)
     *   Mar 12   → 'MESM6'  (past 2nd Thursday, rolled to June)
     *   Jun 11   → 'MESU6'  (past 2nd Thursday, rolled to September)
     *   Dec 11+  → 'MESH7'  (rolled to March 2027)
     */
    public static getActiveCMEContract(baseSymbol: string = 'MES'): string {
        const now = MarketClock.getEasternTime();
        const currentMonth = now.getMonth();
        const currentDay = now.getDate();
        const currentYear = now.getFullYear();

        for (let i = 0; i < ContractResolver.QUARTER_MONTHS.length; i++) {
            const expirationMonth = ContractResolver.QUARTER_MONTHS[i];
            const monthCode = ContractResolver.QUARTER_CODES[i];

            // Skip quarters that have already passed entirely
            if (currentMonth > expirationMonth) continue;

            // Calculate roll date: 2nd Thursday of the expiration month
            const rollDay = ContractResolver.getSecondThursday(currentYear, expirationMonth);

            // If we're in the expiration month and past the roll date, skip to next
            if (currentMonth === expirationMonth && currentDay >= rollDay) {
                continue;
            }

            // This quarter's contract is still active
            const yearDigit = currentYear % 10;
            return `${baseSymbol}${monthCode}${yearDigit}`;
        }

        // All quarters exhausted — roll into NEXT year's March (H)
        const nextYear = currentYear + 1;
        const yearDigit = nextYear % 10;
        return `${baseSymbol}H${yearDigit}`;
    }
}
