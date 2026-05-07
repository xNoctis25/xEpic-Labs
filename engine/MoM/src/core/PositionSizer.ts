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
    maxLossLimit?: number;   // Limit for trailing drawdown
    maxPositionSize?: number;// Limit for max contracts
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
        
        // Dynamic ceiling: override config if Prop Firm provides a strict limit
        const maxCap = propOverride?.maxPositionSize || config.MAX_CONTRACTS;

        // ==========================================
        // PROP FIRM OVERRIDE — Dynamic Linear Scaling ($1500 = 1 ES)
        // ==========================================
        if (propOverride && propOverride.maxLossLimit) {
            const lossLimit = Math.abs(propOverride.maxLossLimit);
            // Allow negative buffer (drawdown) so Available Loss shrinks appropriately
            const buffer = Number(propOverride.currentBuffer);
            
            // 1. Calculate how much dollar loss we can actually sustain before hitting the limit
            const availableLoss = lossLimit + buffer;

            // 2. Linear Scaling Model: 1 ES per $1500 of Available Loss
            //    This mathematically guarantees starting with 3 ES on a $4500 limit at $0 buffer.
            let potentialES = Math.floor(availableLoss / 1500);

            // 3. Ensure we don't exceed the prop firm's hard max contract limit (expressed in Minis)
            if (maxCap > 0) potentialES = Math.min(potentialES, maxCap);

            let finalQty = 0;
            let finalSymbol: 'ES' | 'MES' = 'MES';

            if (baseIndex === 'ES') {
                if (potentialES >= 1) {
                    finalQty = potentialES;
                    finalSymbol = 'ES';
                } else {
                    // Fallback to MES if Available Loss drops below $1500
                    // $150 per MES (1/10th scale)
                    let potentialMES = Math.floor(availableLoss / 150);
                    // Topstep max capacity is expressed in Minis, so Micros limit is 10x
                    if (maxCap > 0) potentialMES = Math.min(potentialMES, maxCap * 10);
                    
                    if (potentialMES >= 1) {
                        finalQty = potentialMES;
                        finalSymbol = 'MES';
                    }
                }
            } else {
                // MES Only mode
                let potentialMES = Math.floor(availableLoss / 150);
                if (maxCap > 0) potentialMES = Math.min(potentialMES, maxCap * 10);
                
                if (potentialMES >= 1) {
                    finalQty = potentialMES;
                    finalSymbol = 'MES';
                }
            }

            // Estimate theoretical risk budget for reporting
            const riskBudget = finalSymbol === 'ES' ? finalQty * 1000 : finalQty * 100;

            if (finalQty >= 1) {
                console.log(
                    `📐 [PositionSizer] - PROP LINEAR ($1500/ES) | Buffer $${buffer.toFixed(2)}` +
                    ` | MaxLoss: $${lossLimit} | AvailLoss: $${availableLoss.toFixed(2)}` +
                    ` → ${finalSymbol} × ${finalQty}`
                );
                return { symbolRoot: finalSymbol, qty: finalQty, riskBudget };
            }

            console.log(
                `📐 [PositionSizer] - PROP REJECTED | Buffer $${buffer.toFixed(2)}` +
                ` | AvailLoss: $${availableLoss.toFixed(2)}` +
                ` → Dangerously close to blowout limit! Trading halted.`
            );
            return null;
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
            if (maxCap > 0) {
                potentialMES = Math.min(potentialMES, maxCap);
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
            if (maxCap > 0) {
                potentialES = Math.min(potentialES, maxCap);
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
            if (maxCap > 0) {
                potentialMES = Math.min(potentialMES, maxCap);
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
