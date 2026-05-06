import cron from 'node-cron';
import { NeonDatabase, BotPhase } from '../services/NeonDatabase';
import { HaltManager } from '../services/HaltManager';
import { SessionLedger } from '../services/SessionLedger';

/**
 * EvaluationEngine — Lifecycle State Machine + EoDR Generator (Cash Account)
 *
 * Two scheduled jobs:
 *   1. 16:00 ET — State machine evaluation (promotion only)
 *   2. 17:15 ET — EoDR generation during CME maintenance window
 *
 * State Transitions:
 *   BACKTEST → EVALUATION  : (manual reset after passing new backtest)
 *   EVALUATION → LIVE      : 20 profitable trading days (running_pnl > 0)
 *
 * Pure Cash Account — no forced drawdown demotions.
 * On promotion, P&L and trading days are RESET to 0.
 */
export class EvaluationEngine {
    private db: NeonDatabase;
    private haltManager: HaltManager;
    private currentPhase: BotPhase = 'EVALUATION';

    constructor(db: NeonDatabase, haltManager: HaltManager) {
        this.db = db;
        this.haltManager = haltManager;
    }

    /**
     * Loads the current phase from the database on boot.
     */
    public async initialize(): Promise<BotPhase> {
        const state = await this.db.getState();
        this.currentPhase = state.currentPhase;
        console.log(`🏛️ [EvaluationEngine] - Current Phase: ${this.currentPhase}`);
        console.log(`🏛️ [EvaluationEngine] - Active Days: ${state.activeTradingDays}/20 | Running P&L: $${state.runningPnl.toFixed(2)}`);
        return this.currentPhase;
    }

    /**
     * Returns the current lifecycle phase (cached in RAM for fast access).
     */
    public getPhase(): BotPhase {
        return this.currentPhase;
    }

    /**
     * End-of-Day Evaluation — called at 16:00 ET with the session's net P&L.
     */
    public async evaluateEndOfDay(sessionPnL: number): Promise<void> {
        console.log(`\n🏛️ [EvaluationEngine] - End-of-Day Evaluation Triggered.`);
        console.log(`🏛️ [EvaluationEngine] - Today's Session P&L: ${sessionPnL >= 0 ? '+' : ''}$${sessionPnL.toFixed(2)}`);

        // 1. Persist today's P&L to the database
        await this.db.updatePnL(sessionPnL);
        await this.db.incrementTradingDay();

        // 2. Fetch the updated state
        const state = await this.db.getState();

        console.log(`🏛️ [EvaluationEngine] - Running P&L: $${state.runningPnl.toFixed(2)} | Days: ${state.activeTradingDays}/20 | Phase: ${state.currentPhase}`);

        // ==========================================
        // Prop Firm Accounts Evaluation
        // ==========================================
        try {
            const propRes = await (this.db as any).pool.query(`SELECT id, account_name, phase FROM prop_accounts WHERE status = 'ACTIVE'`);
            const activeProps = propRes.rows;
            if (activeProps.length > 0) {
                console.log(`\n🏦 [EvaluationEngine] - Evaluating ${activeProps.length} ACTIVE Prop Firm Account(s)...`);
                for (const acc of activeProps) {
                    await this.db.updateAccountPnL(acc.id, sessionPnL);
                    
                    // Re-fetch to check if it passed
                    const afterRes = await (this.db as any).pool.query(`SELECT status FROM prop_accounts WHERE id = $1`, [acc.id]);
                    if (afterRes.rows.length > 0 && afterRes.rows[0].status === 'PASSED') {
                        console.log(`🛑 [EvaluationEngine] - Account ${acc.account_name} PASSED! Triggering global halt.`);
                        await this.haltManager.triggerHalt('CHALLENGE_PASSED');
                    }
                }
            }
        } catch (err: any) {
            console.error(`🔴 [EvaluationEngine] - Failed to evaluate Prop Accounts: ${err.message}`);
        }

        // ==========================================
        // Rule 1: PROMOTION — Evaluation Complete (Cash Account)
        // ==========================================
        if (state.currentPhase === 'EVALUATION' && state.activeTradingDays >= 20 && state.runningPnl > 0) {
            console.log(`🟢 [EvaluationEngine] - PROMOTION! 20 days completed with positive P&L ($${state.runningPnl.toFixed(2)}).`);
            console.log(`🟢 [EvaluationEngine] - Phase: EVALUATION → LIVE. Full execution enabled.`);
            await this.db.updatePhase('LIVE');
            await this.db.resetForNewPhase();
            this.currentPhase = 'LIVE';
            return;
        }

        // ==========================================
        // Rule 2: CONTINUATION — Keep Evaluating
        // ==========================================
        const daysRemaining = Math.max(0, 20 - state.activeTradingDays);
        console.log(`🏛️ [EvaluationEngine] - Evaluation continues. ${daysRemaining} day(s) remaining.`);
        this.currentPhase = state.currentPhase;
    }

    // ==========================================
    // End of Day Report (EoDR) — CME Maintenance Window
    // ==========================================
    /**
     * Generates a comprehensive End of Day Report, prints it to console,
     * and saves it to the daily_reports table in Neon Postgres.
     */
    public async generateEoDR(ledger: SessionLedger): Promise<void> {
        console.log(`\n📋 ═══════════════════════════════════════════`);
        console.log(`📋  M.o.M END OF DAY REPORT (EoDR)`);
        console.log(`📋  ${new Date().toLocaleDateString('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}`);
        console.log(`📋 ═══════════════════════════════════════════\n`);

        const sessionPnL = ledger.getSessionPnL();
        const totalTrades = await this.db.getTodaysTradeCount();
        const state = await this.db.getState();

        // Build the summary text from session data
        const pnlStr = sessionPnL >= 0 ? `+$${sessionPnL.toFixed(2)}` : `-$${Math.abs(sessionPnL).toFixed(2)}`;
        const lines: string[] = [
            `Took ${totalTrades} trade(s). Net P&L: ${pnlStr}.`,
            `Phase: ${state.currentPhase} | Running P&L: $${state.runningPnl.toFixed(2)} | Day ${state.activeTradingDays}/20.`,
        ];

        const eodrSummary = lines.join('\n');

        // Print to console
        console.log(eodrSummary);
        console.log(`\n📋 ═══════════════════════════════════════════\n`);

        // Save to Neon Postgres
        try {
            await this.db.insertDailyReport({
                totalTrades,
                netPnl: sessionPnL,
                rejectedSetupsLog: [],
                eodrSummary,
            });
        } catch (error: any) {
            console.error(`🔴 [EvaluationEngine] - Failed to save EoDR:`, error.message);
        }
    }

    /**
     * Starts both scheduled cron jobs:
     *   1. 16:45 ET (Mon-Fri) — State machine evaluation (after EOD flatten at 16:30)
     *   2. 17:15 ET (Mon-Fri) — EoDR generation during CME maintenance
     */
    public startSchedulers(
        getSessionPnL: () => number,
        ledger: SessionLedger,
    ): void {
        // 16:45 ET — State Machine Evaluation (runs after 16:30 EOD flatten)
        cron.schedule('45 16 * * 1-5', async () => {
            console.log(`\n⏰ [EvaluationEngine] - 16:45 ET EOD evaluation trigger fired.`);
            const sessionPnL = getSessionPnL();
            await this.evaluateEndOfDay(sessionPnL);
        }, {
            timezone: 'America/New_York',
        });

        // 17:15 ET — EoDR (during CME maintenance window 17:00-18:00)
        cron.schedule('15 17 * * 1-5', async () => {
            console.log(`\n⏰ [EvaluationEngine] - 17:15 ET CME maintenance — generating EoDR...`);
            await this.generateEoDR(ledger);
        }, {
            timezone: 'America/New_York',
        });

        console.log('🏛️ [EvaluationEngine] - Crons scheduled: 16:45 ET (evaluation) + 17:15 ET (EoDR).');
    }
}
