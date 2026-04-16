import { MarketClock } from './MarketClock';

/**
 * ContractManager — Automatic CME Contract Rollover
 *
 * Dynamically calculates the active front-month contract symbol for CME Micro futures.
 * Eliminates manual symbol updates by computing the correct contract code based on
 * the current Eastern Time date and CME's quarterly expiration cycle.
 *
 * CME Quarterly Months:
 *   H = March  |  M = June  |  U = September  |  Z = December
 *
 * Rollover Rule:
 *   Roll to the next contract on the 8th day of the expiration month.
 *   Before the 8th, the current quarter's contract is still active.
 *   On/after the 8th, the next quarter's contract becomes active.
 */
export class ContractManager {
    // CME quarterly month codes in calendar order
    private static readonly QUARTER_CODES = ['H', 'M', 'U', 'Z'] as const;
    // Corresponding expiration months (0-indexed): Mar=2, Jun=5, Sep=8, Dec=11
    private static readonly QUARTER_MONTHS = [2, 5, 8, 11] as const;

    /**
     * Returns the active CME front-month contract symbol for the given base product.
     *
     * @param baseSymbol - The product root (e.g., 'MES', 'MNQ', 'MYM', 'M2K')
     * @returns Full contract symbol (e.g., 'MESM6' for June 2026)
     *
     * Examples (assuming rollover on the 8th):
     *   Jan 15, 2026 → 'MESH6'  (March 2026)
     *   Mar 07, 2026 → 'MESH6'  (March 2026 — before rollover)
     *   Mar 08, 2026 → 'MESM6'  (June 2026 — rolled)
     *   Apr 16, 2026 → 'MESM6'  (June 2026)
     *   Sep 09, 2026 → 'MESZ6'  (December 2026)
     *   Dec 10, 2026 → 'MESH7'  (March 2027 — year rolls)
     */
    public static getActiveSymbol(baseSymbol: string = 'MES'): string {
        const now = MarketClock.getEasternTime();
        const month = now.getMonth();   // 0-indexed: Jan=0, Dec=11
        const day = now.getDate();
        const year = now.getFullYear();

        let contractCode: string;
        let contractYear: number = year;

        // Determine which quarterly contract is active
        // Walk through quarters to find the next unexpired one
        if (month < 2 || (month === 2 && day < 8)) {
            // Jan, Feb, or Mar before the 8th → March (H)
            contractCode = 'H';
        } else if (month < 5 || (month === 5 && day < 8)) {
            // Mar 8+, Apr, May, or Jun before the 8th → June (M)
            contractCode = 'M';
        } else if (month < 8 || (month === 8 && day < 8)) {
            // Jun 8+, Jul, Aug, or Sep before the 8th → September (U)
            contractCode = 'U';
        } else if (month < 11 || (month === 11 && day < 8)) {
            // Sep 8+, Oct, Nov, or Dec before the 8th → December (Z)
            contractCode = 'Z';
        } else {
            // Dec 8+ → March of NEXT year (H)
            contractCode = 'H';
            contractYear = year + 1;
        }

        // CME uses single-digit year (last digit): 2026 → 6, 2027 → 7
        const yearDigit = contractYear % 10;

        const symbol = `${baseSymbol}${contractCode}${yearDigit}`;
        return symbol;
    }

    /**
     * Returns a human-readable description of the active contract.
     * Example: "June 2026 (MESM6)"
     */
    public static getContractDescription(baseSymbol: string = 'MES'): string {
        const symbol = ContractManager.getActiveSymbol(baseSymbol);
        const code = symbol.charAt(symbol.length - 2);
        const yearDigit = parseInt(symbol.charAt(symbol.length - 1), 10);
        const fullYear = 2020 + yearDigit; // Works for 2020-2029

        const monthNames: Record<string, string> = {
            'H': 'March', 'M': 'June', 'U': 'September', 'Z': 'December',
        };

        return `${monthNames[code]} ${fullYear} (${symbol})`;
    }
}
