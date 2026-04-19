import { PositionSizer } from './PositionSizer';

/**
 * RiskEngine — Dynamic Daily Loss Management
 *
 * Halts all trading if the daily realized P&L exceeds a dynamic loss limit.
 *
 * Dynamic Limit:
 *   dailyLossLimit = -3 × RiskBudget (allows 3 full stop-outs before halting)
 *
 * The risk budget is recalculated from PositionSizer on each P&L update,
 * making the limit scale with both account size and the active risk profile.
 */
export class RiskEngine {
    private dailyRealizedPnL: number = 0.0;
    private isHalted: boolean = false;

    // Snapshot of buying power at session start, set via setBuyingPower()
    private sessionBuyingPower: number = 0;

    constructor() {
        this.scheduleMidnightReset();
    }

    /**
     * Sets the buying power baseline for dynamic limit calculations.
     * Called once during boot after the SessionLedger syncs from the broker.
     */
    public setBuyingPower(buyingPower: number): void {
        this.sessionBuyingPower = buyingPower;
        const dynamicLimit = this.getDailyLossLimit();
        console.log(`🛡️ [RiskEngine] - Session Buying Power: $${buyingPower.toFixed(2)} | Dynamic Daily Limit: $${dynamicLimit.toFixed(2)}`);
    }

    /**
     * Calculates the dynamic daily loss limit.
     * Allows 3 full stop-outs before halting: -3 × RiskBudget.
     */
    private getDailyLossLimit(): number {
        const riskBudget = PositionSizer.getRiskBudget(this.sessionBuyingPower);
        return -(3 * riskBudget);
    }

    public updatePnL(realizedTradePnL: number): void {
        this.dailyRealizedPnL += realizedTradePnL;
        console.log(`🛡️ [RiskEngine] - Daily PnL Updated: $${this.dailyRealizedPnL.toFixed(2)}`);
        this.evaluateRisk();
    }

    private evaluateRisk(): void {
        const dynamicLimit = this.getDailyLossLimit();
        if (this.dailyRealizedPnL <= dynamicLimit && !this.isHalted) {
            this.isHalted = true;
            console.error(`🛑 [RiskEngine] - HARD HALT TRIGGERED. Daily Loss ($${this.dailyRealizedPnL.toFixed(2)}) breached dynamic limit ($${dynamicLimit.toFixed(2)}).`);
        }
    }

    public canTrade(): boolean {
        return !this.isHalted;
    }

    private scheduleMidnightReset(): void {
        // Resets daily PnL at midnight ET
        setInterval(() => {
            const now = new Date();
            const estTime = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
            if (estTime.getHours() === 0 && estTime.getMinutes() === 0) {
                console.log(`🔄 [RiskEngine] - Midnight ET Reset. PnL cleared.`);
                this.dailyRealizedPnL = 0.0;
                this.isHalted = false;
            }
        }, 60000); // Check every minute
    }
}
