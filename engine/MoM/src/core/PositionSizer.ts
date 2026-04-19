import { config } from '../config/env';

/**
 * PositionSizer — Dynamic Position Sizing with Pure Math
 *
 * Calculates the optimal contract type (ES vs MES) and quantity based on
 * available buying power, the configured RISK percentage (whole integer 1-10),
 * and the current stop-loss distance in points.
 *
 * RISK (env):
 *   A whole number from 1 to 10 representing the percent of buying power
 *   to risk per trade. e.g., RISK=2 means 2% of available buying power.
 *
 * Core Rule (Pure Math, Zero Forced Minimums):
 *   1. RiskBudget = availableBuyingPower * (RISK / 100)
 *   2. If (RiskBudget / ES_Risk) >= 3 → trade ES at that quantity
 *   3. Else if (RiskBudget / MES_Risk) >= 1 → trade MES at that quantity
 *   4. Else → null (account cannot afford the trade, reject it)
 */

export interface SizingResult {
    symbolRoot: string;   // 'ES' or 'MES'
    qty: number;          // Number of contracts
    riskBudget: number;   // Dollar amount at risk this trade
}

// Dollar-per-point multipliers for CME S&P futures
const ES_DOLLAR_PER_POINT = 50;   // ES: $50/point
const MES_DOLLAR_PER_POINT = 5;   // MES: $5/point

// Day trade margin per contract
export const ES_DAY_MARGIN = 500;   // $500/contract for ES
export const MES_DAY_MARGIN = 50;   // $50/contract for MES

export class PositionSizer {
    /**
     * Calculates the optimal position size for a given account and stop-loss.
     *
     * @param availableBuyingPower - Current buying power from SessionLedger ($)
     * @param slPoints             - Stop-loss distance in index points (e.g. 20)
     * @returns SizingResult with symbolRoot, qty, and riskBudget — or null if unaffordable
     */
    public static calculate(availableBuyingPower: number, slPoints: number): SizingResult | null {
        const riskPercent = config.RISK / 100;
        const riskBudget = availableBuyingPower * riskPercent;

        // Risk per contract at the given stop-loss distance
        const esRisk = slPoints * ES_DOLLAR_PER_POINT;    // e.g., 20 pts × $50 = $1,000
        const mesRisk = slPoints * MES_DOLLAR_PER_POINT;   // e.g., 20 pts × $5  = $100

        // --- Attempt ES first (upgrade when account can afford ≥3 contracts) ---
        const potentialES = Math.floor(riskBudget / esRisk);
        if (potentialES >= 3) {
            console.log(
                `📐 [PositionSizer] - Risk: ${config.RISK}%` +
                ` | Budget: $${riskBudget.toFixed(2)} | ES Risk/ct: $${esRisk}` +
                ` → ES × ${potentialES}`
            );
            return { symbolRoot: 'ES', qty: potentialES, riskBudget };
        }

        // --- Fallback to MES ---
        const potentialMES = Math.floor(riskBudget / mesRisk);
        if (potentialMES >= 1) {
            console.log(
                `📐 [PositionSizer] - Risk: ${config.RISK}%` +
                ` | Budget: $${riskBudget.toFixed(2)} | MES Risk/ct: $${mesRisk}` +
                ` → MES × ${potentialMES}`
            );
            return { symbolRoot: 'MES', qty: potentialMES, riskBudget };
        }

        // --- Account cannot afford even 1 MES contract at this SL ---
        console.log(
            `📐 [PositionSizer] - Risk: ${config.RISK}%` +
            ` | Budget: $${riskBudget.toFixed(2)} | MES Risk/ct: $${mesRisk}` +
            ` → REJECTED (insufficient risk budget)`
        );
        return null;
    }

    /**
     * Returns the current risk budget based on buying power and RISK %.
     * Used by RiskEngine for dynamic daily loss limit calculation.
     */
    public static getRiskBudget(availableBuyingPower: number): number {
        const riskPercent = config.RISK / 100;
        return availableBuyingPower * riskPercent;
    }
}
