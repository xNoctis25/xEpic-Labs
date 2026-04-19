import { config } from '../config/env';

/**
 * PositionSizer — Dynamic Position Sizing with Strict Ceiling Math
 *
 * Calculates the contract type and quantity based on available buying power,
 * the clamped RISK percentage (1-10), and the env.INDICES strict ceiling.
 *
 * RISK (env):
 *   A whole number from 1 to 10 representing the percent of buying power
 *   to risk per trade. Clamped via Math.min(10, Math.max(1, RISK)).
 *
 * Strict Ceiling Rules:
 *   INDICES='MES' → MES only. Never upgrade to ES regardless of budget.
 *   INDICES='ES'  → Try ES first. If unaffordable, fallback to MES.
 *
 * Core Math:
 *   1. safeRisk = clamp(RISK, 1, 10)
 *   2. RiskBudget = availableBuyingPower * (safeRisk / 100)
 *   3. Apply strict ceiling rules based on baseIndex
 *   4. If no contracts affordable → null (reject the trade)
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
     * Calculates the optimal position size with strict ceiling enforcement.
     *
     * @param availableBuyingPower - Current buying power from SessionLedger ($)
     * @param slPoints             - Stop-loss distance in index points (e.g. 20)
     * @param baseIndex            - The configured ceiling index (config.INDICES: 'MES' or 'ES')
     * @returns SizingResult with symbolRoot, qty, and riskBudget — or null if unaffordable
     */
    public static calculate(
        availableBuyingPower: number,
        slPoints: number,
        baseIndex: string,
    ): SizingResult | null {
        // Safety clamp: enforce 1-10% range regardless of .env value
        const safeRisk = Math.min(10, Math.max(1, config.RISK));
        const riskBudget = availableBuyingPower * (safeRisk / 100);

        // Risk per contract at the given stop-loss distance
        const esRisk = slPoints * ES_DOLLAR_PER_POINT;    // e.g., 20 pts × $50 = $1,000
        const mesRisk = slPoints * MES_DOLLAR_PER_POINT;   // e.g., 20 pts × $5  = $100

        // ==========================================
        // Strict Ceiling: MES — never upgrade to ES
        // ==========================================
        if (baseIndex === 'MES') {
            const potentialMES = Math.floor(riskBudget / mesRisk);
            if (potentialMES >= 1) {
                console.log(
                    `📐 [PositionSizer] - Risk: ${safeRisk}% | Ceiling: MES` +
                    ` | Budget: $${riskBudget.toFixed(2)} | MES Risk/ct: $${mesRisk}` +
                    ` → MES × ${potentialMES}`
                );
                return { symbolRoot: 'MES', qty: potentialMES, riskBudget };
            }

            // Cannot afford even 1 MES contract
            console.log(
                `📐 [PositionSizer] - Risk: ${safeRisk}% | Ceiling: MES` +
                ` | Budget: $${riskBudget.toFixed(2)} | MES Risk/ct: $${mesRisk}` +
                ` → REJECTED (insufficient risk budget)`
            );
            return null;
        }

        // ==========================================
        // ES Mode: Try ES first, fallback to MES
        // ==========================================
        if (baseIndex === 'ES') {
            const potentialES = Math.floor(riskBudget / esRisk);
            if (potentialES >= 1) {
                console.log(
                    `📐 [PositionSizer] - Risk: ${safeRisk}% | Ceiling: ES` +
                    ` | Budget: $${riskBudget.toFixed(2)} | ES Risk/ct: $${esRisk}` +
                    ` → ES × ${potentialES}`
                );
                return { symbolRoot: 'ES', qty: potentialES, riskBudget };
            }

            // ES unaffordable — fallback to MES
            const potentialMES = Math.floor(riskBudget / mesRisk);
            if (potentialMES >= 1) {
                console.log(
                    `📐 [PositionSizer] - Risk: ${safeRisk}% | Ceiling: ES (fallback MES)` +
                    ` | Budget: $${riskBudget.toFixed(2)} | MES Risk/ct: $${mesRisk}` +
                    ` → MES × ${potentialMES}`
                );
                return { symbolRoot: 'MES', qty: potentialMES, riskBudget };
            }

            // Cannot afford either
            console.log(
                `📐 [PositionSizer] - Risk: ${safeRisk}% | Ceiling: ES` +
                ` | Budget: $${riskBudget.toFixed(2)} | MES Risk/ct: $${mesRisk}` +
                ` → REJECTED (insufficient risk budget)`
            );
            return null;
        }

        // Unknown baseIndex — reject
        console.error(`📐 [PositionSizer] - Unknown INDICES value: '${baseIndex}'. Expected 'MES' or 'ES'.`);
        return null;
    }

    /**
     * Returns the current risk budget based on buying power and clamped RISK %.
     * Used by RiskEngine for dynamic daily loss limit calculation.
     */
    public static getRiskBudget(availableBuyingPower: number): number {
        const safeRisk = Math.min(10, Math.max(1, config.RISK));
        return availableBuyingPower * (safeRisk / 100);
    }
}
