import { MarketClock } from '../core/MarketClock';

/**
 * ContractBuilder — Continuous CME Contract Rollover
 *
 * Dynamically calculates the active front-month contract symbol for CME
 * Equity Index Micro futures (ES, MES, MNQ, MYM, M2K, etc.).
 *
 * CME Quarterly Expiration Months:
 *   H = March  |  M = June  |  U = September  |  Z = December
 *
 * Expiration Rule:
 *   CME Equity futures expire on the 3rd Friday of the contract month.
 *
 * Volume Rollover Rule:
 *   Volume migrates to the next contract ~8 calendar days before expiration.
 *   The "Roll Date" is calculated as: 3rd Friday − 8 days (the preceding Thursday).
 *   On or after the Roll Date, the NEXT quarter's contract becomes active.
 *
 * All date instantiations are derived from MarketClock.getEasternTime() to
 * guarantee consistent behavior regardless of host server timezone.
 */
export class ContractBuilder {
    // CME quarterly month codes in calendar order
    private static readonly QUARTER_CODES = ['H', 'M', 'U', 'Z'] as const;
    // Corresponding expiration months (0-indexed): Mar=2, Jun=5, Sep=8, Dec=11
    private static readonly QUARTER_MONTHS = [2, 5, 8, 11] as const;

    /**
     * Finds the 3rd Friday of a given month/year.
     *
     * Algorithm:
     *   1. Start on the 1st of the month.
     *   2. Find the first Friday (day-of-week 5).
     *   3. Add 14 days to reach the 3rd Friday.
     *
     * @param year  - Full year (e.g. 2026)
     * @param month - 0-indexed month (e.g. 2 = March)
     * @returns The day-of-month of the 3rd Friday
     */
    private static getThirdFriday(year: number, month: number): number {
        // Build a Date for the 1st of the target month in ET
        const firstOfMonth = MarketClock.getEasternTime(
            new Date(year, month, 1).getTime()
        );
        const dayOfWeek = firstOfMonth.getDay(); // 0=Sun, 5=Fri

        // Days until the first Friday: if the 1st is a Friday (5), offset=0
        const daysUntilFirstFriday = (5 - dayOfWeek + 7) % 7;
        const firstFriday = 1 + daysUntilFirstFriday;
        const thirdFriday = firstFriday + 14;

        return thirdFriday;
    }

    /**
     * Returns the active CME front-month contract symbol for the given root.
     *
     * @param symbolRoot - The product root (e.g., 'MES', 'ES', 'MNQ', 'MYM', 'M2K')
     * @returns Full contract symbol (e.g., 'MESM6' for June 2026)
     *
     * Examples (2026):
     *   Jan 15   → 'MESH6'  (March 2026 — no roll yet)
     *   Mar 12   → 'MESH6'  (3rd Fri is Mar 20, roll = Mar 12 → ON the roll date, shifts to next)
     *   Mar 12   → 'MESM6'  (rolled to June on the 12th)
     *   Apr 19   → 'MESM6'  (June 2026)
     *   Dec 12+  → 'MESH7'  (March 2027 — year rolls)
     */
    public static getActiveContract(symbolRoot: string): string {
        const now = MarketClock.getEasternTime();
        const currentMonth = now.getMonth();
        const currentDay = now.getDate();
        const currentYear = now.getFullYear();

        // Walk the quarterly cycle to find the current contract
        // We check each quarter in order. If we are past the roll date for a quarter,
        // that quarter's contract has expired and we move to the next.
        for (let i = 0; i < ContractBuilder.QUARTER_MONTHS.length; i++) {
            const expirationMonth = ContractBuilder.QUARTER_MONTHS[i];
            const monthCode = ContractBuilder.QUARTER_CODES[i];
            const contractYear = currentYear;

            // Only consider quarters that haven't passed yet
            if (currentMonth > expirationMonth) continue;

            // Calculate roll date: 3rd Friday − 8 days
            const thirdFriday = ContractBuilder.getThirdFriday(contractYear, expirationMonth);
            const rollDay = thirdFriday - 8;

            // If we're in the expiration month, check against roll date
            if (currentMonth === expirationMonth && currentDay >= rollDay) {
                // Past the roll date — this contract has rolled, skip to next quarter
                continue;
            }

            // This quarter's contract is still active
            const yearDigit = contractYear % 10;
            return `${symbolRoot}${monthCode}${yearDigit}`;
        }

        // If we exhausted all quarters in the current year, we've rolled into
        // the NEXT year's March (H) contract
        const nextYear = currentYear + 1;
        const yearDigit = nextYear % 10;
        return `${symbolRoot}H${yearDigit}`;
    }

    /**
     * Returns a human-readable description of the active contract.
     * Example: "June 2026 (MESM6)"
     */
    public static getContractDescription(symbolRoot: string): string {
        const symbol = ContractBuilder.getActiveContract(symbolRoot);
        const code = symbol.charAt(symbol.length - 2);
        const yearDigit = parseInt(symbol.charAt(symbol.length - 1), 10);

        // Derive the full year from the current decade
        const now = MarketClock.getEasternTime();
        const decade = Math.floor(now.getFullYear() / 10) * 10;
        const fullYear = decade + yearDigit;

        const monthNames: Record<string, string> = {
            'H': 'March', 'M': 'June', 'U': 'September', 'Z': 'December',
        };

        return `${monthNames[code] || 'Unknown'} ${fullYear} (${symbol})`;
    }
}
