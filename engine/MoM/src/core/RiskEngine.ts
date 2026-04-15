import { config } from '../config/env';

export class RiskEngine {
    private dailyRealizedPnL: number = 0.0;
    private isHalted: boolean = false;

    constructor() {
        this.scheduleMidnightReset();
    }

    public updatePnL(realizedTradePnL: number): void {
        this.dailyRealizedPnL += realizedTradePnL;
        console.log(`🛡️ [RiskEngine] - Daily PnL Updated: $${this.dailyRealizedPnL.toFixed(2)}`);
        this.evaluateRisk();
    }

    private evaluateRisk(): void {
        if (this.dailyRealizedPnL <= config.DAILY_LOSS_LIMIT && !this.isHalted) {
            this.isHalted = true;
            console.error(`🛑 [RiskEngine] - HARD HALT TRIGGERED. Daily Loss Limit ($${config.DAILY_LOSS_LIMIT}) Reached.`);
        }
    }

    public canTrade(): boolean {
        return !this.isHalted;
    }

    private scheduleMidnightReset(): void {
        // Calculates time until Midnight ET and resets daily PnL
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
