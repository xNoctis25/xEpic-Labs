import { config } from '../config/env';
import { PropPhase, PropRiskProfile } from '../services/NeonDatabase';

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

/**
 * PropOverride — When present, bypasses cash math and uses strict scaling ladders.
 * Passed by MoMEngine when a prop firm account is active.
 */
export interface PropOverride {
    phase: PropPhase;
    riskProfile: PropRiskProfile;
    currentBuffer: number;   // Total P&L buffer from the DB
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
        propOverride?: PropOverride,
    ): SizingResult | null {
        // ==========================================
        // PROP FIRM OVERRIDE — Mega Heist Scaling Ladder
        // ==========================================
        if (propOverride) {
            // EVAL Phase: Symmetrical Overshoot — Always 3 ES
            if (propOverride.phase === 'EVAL') {
                console.log(`📐 [PositionSizer] - PROP EVAL: 3× ES (Symmetrical Overshoot)`);
                return { symbolRoot: 'ES', qty: 3, riskBudget: 0 };
            }

            // FUNDED Phase: The Scaling Ladder
            if (propOverride.phase === 'FUNDED') {
                const buffer = Number(propOverride.currentBuffer);
                let qty = 1;
                let tier = '';

                if (propOverride.riskProfile === 'SAFE') {
                    if (buffer < 4500)       { qty = 1;  tier = 'The Trench'; }
                    else if (buffer < 10000) { qty = 3;  tier = 'The Armor'; }
                    else if (buffer < 20000) { qty = 5;  tier = 'Momentum'; }
                    else if (buffer < 30000) { qty = 10; tier = 'Heavyweight'; }
                    else                     { qty = 15; tier = 'Final Boss'; }
                } else if (propOverride.riskProfile === 'AGGRESSIVE') {
                    if (buffer < 10000)      { qty = 3;  tier = 'The Sprint'; }
                    else if (buffer < 25000) { qty = 5;  tier = 'Momentum'; }
                    else if (buffer < 45000) { qty = 10; tier = 'Heavyweight'; }
                    else                     { qty = 15; tier = 'Mega Heist'; }
                }

                console.log(
                    `📐 [PositionSizer] - PROP FUNDED [${propOverride.riskProfile}]:` +
                    ` Buffer $${buffer.toFixed(2)} → ${tier} → ES × ${qty}`
                );
                return { symbolRoot: 'ES', qty, riskBudget: 0 };
            }
        }

        // ==========================================
        // CASH ACCOUNT — Standard Risk Budget Math
        // ==========================================
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
            let potentialMES = Math.floor(riskBudget / mesRisk);

            // Apply Topstep / Prop Firm Cap
            if (config.MAX_CONTRACTS > 0) {
                potentialMES = Math.min(potentialMES, config.MAX_CONTRACTS);
            }

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
            let potentialES = Math.floor(riskBudget / esRisk);

            // Apply Topstep / Prop Firm Cap
            if (config.MAX_CONTRACTS > 0) {
                potentialES = Math.min(potentialES, config.MAX_CONTRACTS);
            }

            if (potentialES >= 1) {
                console.log(
                    `📐 [PositionSizer] - Risk: ${safeRisk}% | Ceiling: ES` +
                    ` | Budget: $${riskBudget.toFixed(2)} | ES Risk/ct: $${esRisk}` +
                    ` → ES × ${potentialES}`
                );
                return { symbolRoot: 'ES', qty: potentialES, riskBudget };
            }

            // ES unaffordable — fallback to MES
            let potentialMES = Math.floor(riskBudget / mesRisk);

            // Apply Topstep / Prop Firm Cap
            if (config.MAX_CONTRACTS > 0) {
                potentialMES = Math.min(potentialMES, config.MAX_CONTRACTS);
            }

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
