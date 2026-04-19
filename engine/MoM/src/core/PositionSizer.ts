import { config } from '../config/env';

/**
 * PositionSizer — 4-Tier Dynamic Risk Profile with Pure Math Position Sizing
 *
 * Calculates the optimal contract type (ES vs MES) and quantity based on
 * available buying power, the configured risk profile, and the current
 * stop-loss distance in points.
 *
 * Risk Tiers:
 *   SAFE       → 1% of available buying power per trade
 *   MODEST     → 2% of available buying power per trade
 *   AGGRESSIVE → 5% of available buying power per trade
 *   MOON       → 10% of available buying power per trade
 *
 * Core Rule (Pure Math, Zero Forced Minimums):
 *   1. RiskBudget = availableBuyingPower * riskPercent
 *   2. If (RiskBudget / ES_Risk) >= 3 → trade ES at that quantity
 *   3. Else if (RiskBudget / MES_Risk) >= 1 → trade MES at that quantity
 *   4. Else → null (account cannot afford the trade, reject it)
 */

export type RiskProfile = 'SAFE' | 'MODEST' | 'AGGRESSIVE' | 'MOON';

export interface SizingResult {
    symbolRoot: string;   // 'ES' or 'MES'
    qty: number;          // Number of contracts
    riskBudget: number;   // Dollar amount at risk this trade
}

const RISK_PERCENTS: Record<RiskProfile, number> = {
    SAFE: 0.01,
    MODEST: 0.02,
    AGGRESSIVE: 0.05,
    MOON: 0.10,
};

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
        const riskPercent = RISK_PERCENTS[config.RISK_PROFILE] ?? RISK_PERCENTS.MODEST;
        const riskBudget = availableBuyingPower * riskPercent;

        // Risk per contract at the given stop-loss distance
        const esRisk = slPoints * ES_DOLLAR_PER_POINT;    // e.g., 20 pts × $50 = $1,000
        const mesRisk = slPoints * MES_DOLLAR_PER_POINT;   // e.g., 20 pts × $5 = $100

        // --- Attempt ES first (upgrade when account can afford ≥3 contracts) ---
        const potentialES = Math.floor(riskBudget / esRisk);
        if (potentialES >= 3) {
            console.log(
                `📐 [PositionSizer] - Profile: ${config.RISK_PROFILE} (${(riskPercent * 100).toFixed(0)}%)` +
                ` | Budget: $${riskBudget.toFixed(2)} | ES Risk/ct: $${esRisk}` +
                ` → ES × ${potentialES}`
            );
            return { symbolRoot: 'ES', qty: potentialES, riskBudget };
        }

        // --- Fallback to MES ---
        const potentialMES = Math.floor(riskBudget / mesRisk);
        if (potentialMES >= 1) {
            console.log(
                `📐 [PositionSizer] - Profile: ${config.RISK_PROFILE} (${(riskPercent * 100).toFixed(0)}%)` +
                ` | Budget: $${riskBudget.toFixed(2)} | MES Risk/ct: $${mesRisk}` +
                ` → MES × ${potentialMES}`
            );
            return { symbolRoot: 'MES', qty: potentialMES, riskBudget };
        }

        // --- Account cannot afford even 1 MES contract at this SL ---
        console.log(
            `📐 [PositionSizer] - Profile: ${config.RISK_PROFILE} (${(riskPercent * 100).toFixed(0)}%)` +
            ` | Budget: $${riskBudget.toFixed(2)} | MES Risk/ct: $${mesRisk}` +
            ` → REJECTED (insufficient risk budget)`
        );
        return null;
    }

    /**
     * Returns the current risk budget based on buying power and profile.
     * Used by RiskEngine for dynamic daily loss limit calculation.
     */
    public static getRiskBudget(availableBuyingPower: number): number {
        const riskPercent = RISK_PERCENTS[config.RISK_PROFILE] ?? RISK_PERCENTS.MODEST;
        return availableBuyingPower * riskPercent;
    }
}
