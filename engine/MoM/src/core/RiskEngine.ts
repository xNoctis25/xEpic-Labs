import { PositionSizer } from './PositionSizer';

/**
 * RiskEngine — Dynamic Daily Loss Management
 *
 * Halts all trading if the daily realized P&L exceeds a dynamic loss limit.
 *
 * Dynamic Limit:
 *   dailyLossLimit = -3 × RiskBudget (allows 3 full stop-outs before halting)
 *
 * The risk budget is passed in from MoMEngine on each trade close,
 * making the limit scale with both account size and the RISK percentage.
 */
export class RiskEngine {
    private dailyRealizedPnL: number = 0.0;
    private isHalted: boolean = false;

    // Last known risk budget, updated on each trade close
    private lastRiskBudget: number = 0;

    constructor() {
        this.scheduleMidnightReset();
    }

    /**
     * Updates the daily P&L and evaluates if the halt threshold is breached.
     *
     * @param realizedTradePnL - The P&L from the just-closed trade
     * @param riskBudget       - The risk budget at the time of this trade (from PositionSizer)
     */
    public updatePnL(realizedTradePnL: number, riskBudget: number): void {
        this.dailyRealizedPnL += realizedTradePnL;
        this.lastRiskBudget = riskBudget;
        console.log(`🛡️ [RiskEngine] - Daily PnL Updated: $${this.dailyRealizedPnL.toFixed(2)}`);
        this.evaluateRisk(riskBudget);
    }

    /**
     * Evaluates if trading should halt for the day.
     * Halt condition: dailyRealizedPnL <= -3 × riskBudget
     *
     * @param riskBudget - Dollar amount the sizer allocated for the last trade
     */
    private evaluateRisk(riskBudget: number): void {
        const dynamicLimit = -(3 * riskBudget);
        if (this.dailyRealizedPnL <= dynamicLimit && !this.isHalted) {
            this.isHalted = true;
            console.error(
                `🛑 [RiskEngine] - HARD HALT TRIGGERED. Daily Loss ($${this.dailyRealizedPnL.toFixed(2)})` +
                ` breached dynamic limit ($${dynamicLimit.toFixed(2)}) [3 × $${riskBudget.toFixed(2)} risk budget].`
            );
        }
    }

    public canTrade(): boolean {
        return !this.isHalted;
    }

    /**
     * Returns the last known risk budget for preflight logging.
     */
    public getLastRiskBudget(): number {
        return this.lastRiskBudget;
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
