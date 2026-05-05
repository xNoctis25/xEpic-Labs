import { Pool } from 'pg';

/**
 * NeonDatabase — Persistent Brain (Neon Serverless Postgres)
 *
 * Stores M.o.M's lifecycle state across restarts:
 *   - Current phase: BACKTEST | EVALUATION | LIVE
 *   - Running P&L and active trading days
 *   - Max drawdown limit for demotion checks
 *
 * Uses a connection pool for non-blocking async queries.
 * Requires NEON_DATABASE_URL in .env (Neon connection string with SSL).
 */

export type BotPhase = 'BACKTEST' | 'EVALUATION' | 'LIVE';

export interface BotState {
    id: number;
    currentPhase: BotPhase;
    startDate: Date;
    activeTradingDays: number;
    runningPnl: number;
    maxDrawdownLimit: number;
}

// ==========================================
// Prop Firm Account Types
// ==========================================
export type PropPhase = 'EVAL' | 'FUNDED';
export type PropRiskProfile = 'SAFE' | 'AGGRESSIVE';
export type PropStatus = 'ACTIVE' | 'PASSED' | 'PAYOUT_READY' | 'BLOWN';

export interface PropAccount {
    id: number;
    account_name: string;
    firm: string;
    phase: PropPhase;
    risk_profile: PropRiskProfile;
    profit_target: number;
    current_pnl: number;
    best_day_pnl: number;
    days_traded: number;
    status: PropStatus;
}

export class NeonDatabase {
    private pool: Pool;

    constructor() {
        let connectionString = process.env.NEON_DATABASE_URL || '';
        if (!connectionString) {
            console.error('[NeonDB] NEON_DATABASE_URL not found in .env.');
        }

        // Suppress pg SSL deprecation warning: replace 'require' with 'verify-full'
        if (connectionString.includes('sslmode=require')) {
            connectionString = connectionString.replace('sslmode=require', 'sslmode=verify-full');
        } else if (connectionString && !connectionString.includes('sslmode=')) {
            connectionString += (connectionString.includes('?') ? '&' : '?') + 'sslmode=verify-full';
        }

        this.pool = new Pool({
            connectionString,
            ssl: { rejectUnauthorized: false },
            max: 5,
            idleTimeoutMillis: 30000,
        });

        // Prevent unhandled pool errors from dumping Client internals to stderr
        this.pool.on('error', (err) => {
            console.warn(`[NeonDB] Pool background error: ${err.message}`);
        });
    }

    /**
     * Initializes the database schema and ensures a default state row exists.
     * Must be called once on boot before any other database operations.
     */
    public async initialize(): Promise<void> {

        // Create the bot_state table if it doesn't exist
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS bot_state (
                id SERIAL PRIMARY KEY,
                current_phase VARCHAR(20) NOT NULL DEFAULT 'EVALUATION',
                start_date TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'),
                active_trading_days INT NOT NULL DEFAULT 0,
                running_pnl NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
                max_drawdown_limit NUMERIC(12, 2) NOT NULL DEFAULT -500.00
            );
        `);

        // Create the trade_journal table — per-trade self-graded records
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS trade_journal (
                id SERIAL PRIMARY KEY,
                timestamp TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York'),
                symbol VARCHAR(20) NOT NULL DEFAULT 'MESM6',
                side VARCHAR(4) NOT NULL,
                qty INT NOT NULL DEFAULT 1,
                entry_price NUMERIC(12, 2) NOT NULL,
                exit_price NUMERIC(12, 2) NOT NULL,
                stop_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
                pnl NUMERIC(12, 2) NOT NULL,
                points_captured NUMERIC(8, 2) NOT NULL DEFAULT 0.00,
                initial_risk_points NUMERIC(8, 2) NOT NULL DEFAULT 0.00,
                mfe_points NUMERIC(8, 2) NOT NULL DEFAULT 0.00,
                mae_points NUMERIC(8, 2) NOT NULL DEFAULT 0.00,
                mfe_excursion NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
                mae_excursion NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
                duration_seconds INT NOT NULL DEFAULT 0,
                rr_achieved NUMERIC(6, 2) NOT NULL DEFAULT 0.00,
                grade VARCHAR(2) NOT NULL DEFAULT 'F',
                notes TEXT,
                trade_metadata JSONB DEFAULT '{}'
            );
        `);
        // Migrate: add new columns if missing (existing deployments)
        const migrations = [
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS duration_seconds INT NOT NULL DEFAULT 0`,
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS rr_achieved NUMERIC(6, 2) NOT NULL DEFAULT 0.00`,
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS symbol VARCHAR(20) NOT NULL DEFAULT 'MESM6'`,
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS qty INT NOT NULL DEFAULT 1`,
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS stop_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00`,
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS points_captured NUMERIC(8, 2) NOT NULL DEFAULT 0.00`,
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS initial_risk_points NUMERIC(8, 2) NOT NULL DEFAULT 0.00`,
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS mfe_points NUMERIC(8, 2) NOT NULL DEFAULT 0.00`,
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS mae_points NUMERIC(8, 2) NOT NULL DEFAULT 0.00`,
            `ALTER TABLE trade_journal ADD COLUMN IF NOT EXISTS trade_metadata JSONB DEFAULT '{}'`,
        ];
        for (const sql of migrations) {
            await this.pool.query(sql);
        }

        // Create the daily_reports table — End of Day Report (EoDR) summaries
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS daily_reports (
                date DATE PRIMARY KEY DEFAULT CURRENT_DATE,
                total_trades INT NOT NULL DEFAULT 0,
                net_pnl NUMERIC(12, 2) NOT NULL DEFAULT 0.00,
                rejected_setups_log JSONB DEFAULT '[]'::jsonb,
                eodr_summary TEXT
            );
        `);

        // Create the prop_accounts table — Master Ledger for Prop Firm Accounts
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS prop_accounts (
                id SERIAL PRIMARY KEY,
                account_name VARCHAR(100) NOT NULL,
                firm VARCHAR(50) NOT NULL,
                phase VARCHAR(10) NOT NULL CHECK (phase IN ('EVAL', 'FUNDED')),
                risk_profile VARCHAR(15) NOT NULL CHECK (risk_profile IN ('SAFE', 'AGGRESSIVE')),
                profit_target NUMERIC(12, 2) NOT NULL DEFAULT 9000,
                current_pnl NUMERIC(12, 2) NOT NULL DEFAULT 0,
                best_day_pnl NUMERIC(12, 2) NOT NULL DEFAULT 0,
                days_traded INT NOT NULL DEFAULT 0,
                status VARCHAR(15) NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','PASSED','PAYOUT_READY','BLOWN'))
            );
        `);

        // Create the mom_telemetry_logs table — async event stream from all worker cores
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS mom_telemetry_logs (
                id        SERIAL PRIMARY KEY,
                source    VARCHAR(50),
                regime    VARCHAR(50),
                message   TEXT,
                trade_id  VARCHAR(50),
                timestamp TIMESTAMP DEFAULT (CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')
            );
        `);

        // Add trade_id column if it doesn't exist (migration for existing DBs)
        await this.pool.query(`
            ALTER TABLE mom_telemetry_logs ADD COLUMN IF NOT EXISTS trade_id VARCHAR(50);
        `);

        // Ensure row 1 exists (seed the initial state if the table is empty)
        const result = await this.pool.query('SELECT COUNT(*) AS cnt FROM bot_state');
        const rowCount = parseInt(result.rows[0].cnt, 10);

        if (rowCount === 0) {
            await this.pool.query(`
                INSERT INTO bot_state (current_phase, start_date, active_trading_days, running_pnl, max_drawdown_limit)
                VALUES ('EVALUATION', NOW(), 0, 0.00, -500.00)
            `);
        }
    }

    /**
     * Fetches the current bot state from the database.
     */
    public async getState(): Promise<BotState> {
        const result = await this.pool.query('SELECT * FROM bot_state WHERE id = 1');

        if (result.rows.length === 0) {
            throw new Error('[NeonDB] - No bot_state row found. Run initialize() first.');
        }

        const row = result.rows[0];
        return {
            id: row.id,
            currentPhase: row.current_phase as BotPhase,
            startDate: new Date(row.start_date),
            activeTradingDays: row.active_trading_days,
            runningPnl: parseFloat(row.running_pnl),
            maxDrawdownLimit: parseFloat(row.max_drawdown_limit),
        };
    }

    /**
     * Updates the running P&L by adding the daily realized P&L.
     * @param dailyPnL - The day's net P&L (positive or negative)
     */
    public async updatePnL(dailyPnL: number): Promise<void> {
        await this.pool.query(
            'UPDATE bot_state SET running_pnl = running_pnl + $1 WHERE id = 1',
            [dailyPnL]
        );
        console.log(`🧠 [NeonDB] - Running P&L updated: ${dailyPnL >= 0 ? '+' : ''}$${dailyPnL.toFixed(2)}`);
    }

    /**
     * Increments the active trading days counter by 1.
     */
    public async incrementTradingDay(): Promise<void> {
        await this.pool.query(
            'UPDATE bot_state SET active_trading_days = active_trading_days + 1 WHERE id = 1'
        );
    }

    /**
     * Updates the bot's lifecycle phase.
     * @param newPhase - The phase to transition to
     */
    public async updatePhase(newPhase: BotPhase): Promise<void> {
        await this.pool.query(
            'UPDATE bot_state SET current_phase = $1 WHERE id = 1',
            [newPhase]
        );
        console.log(`🧠 [NeonDB] - Phase updated to: ${newPhase}`);
    }

    /**
     * Resets running_pnl and active_trading_days to 0 for a fresh phase start.
     * Called on both promotion and demotion to ensure a clean evaluation period.
     */
    public async resetForNewPhase(): Promise<void> {
        await this.pool.query(
            'UPDATE bot_state SET running_pnl = 0.00, active_trading_days = 0, start_date = NOW() WHERE id = 1'
        );
        console.log('🧠 [NeonDB] - P&L and trading days reset for new phase.');
    }

    // ==========================================
    // Trade Journal — Per-Trade Self-Graded Records
    // ==========================================
    /**
     * Inserts an institutional-grade trade record into the journal.
     */
    public async insertTradeJournal(trade: {
        symbol: string;
        side: string;
        qty: number;
        entryPrice: number;
        exitPrice: number;
        stopPrice: number;
        pnl: number;
        pointsCaptured: number;
        initialRiskPoints: number;
        mfePoints: number;
        maePoints: number;
        mfeExcursion: number;
        maeExcursion: number;
        durationSeconds: number;
        rrAchieved: number;
        grade: string;
        notes: string;
        tradeMetadata: Record<string, unknown>;
    }): Promise<void> {
        await this.pool.query(
            `INSERT INTO trade_journal (
                symbol, side, qty, entry_price, exit_price, stop_price, pnl,
                points_captured, initial_risk_points, mfe_points, mae_points,
                mfe_excursion, mae_excursion, duration_seconds, rr_achieved,
                grade, notes, trade_metadata
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
            [
                trade.symbol, trade.side, trade.qty, trade.entryPrice, trade.exitPrice, trade.stopPrice, trade.pnl,
                trade.pointsCaptured, trade.initialRiskPoints, trade.mfePoints, trade.maePoints,
                trade.mfeExcursion, trade.maeExcursion, trade.durationSeconds, trade.rrAchieved,
                trade.grade, trade.notes, JSON.stringify(trade.tradeMetadata),
            ]
        );
        const durMin = Math.floor(trade.durationSeconds / 60);
        const durSec = trade.durationSeconds % 60;
        console.log(`📓 [NeonDB] - Trade journaled: ${trade.symbol} ${trade.side} ×${trade.qty} | P&L: $${trade.pnl.toFixed(2)} | Grade: ${trade.grade} | R:R: ${trade.rrAchieved >= 0 ? '+' : ''}${trade.rrAchieved.toFixed(1)}R | Duration: ${durMin}m ${durSec}s`);
    }

    // ==========================================
    // Daily Reports — End of Day Report (EoDR)
    // ==========================================
    /**
     * Inserts or updates today's End of Day Report.
     * Uses UPSERT (ON CONFLICT) so it's safe to call multiple times.
     */
    public async insertDailyReport(report: {
        totalTrades: number;
        netPnl: number;
        rejectedSetupsLog: string[];
        eodrSummary: string;
    }): Promise<void> {
        await this.pool.query(
            `INSERT INTO daily_reports (date, total_trades, net_pnl, rejected_setups_log, eodr_summary)
             VALUES (CURRENT_DATE, $1, $2, $3::jsonb, $4)
             ON CONFLICT (date) DO UPDATE SET
                total_trades = $1,
                net_pnl = $2,
                rejected_setups_log = $3::jsonb,
                eodr_summary = $4`,
            [report.totalTrades, report.netPnl, JSON.stringify(report.rejectedSetupsLog), report.eodrSummary]
        );
        console.log(`📓 [NeonDB] - Daily report saved for today.`);
    }

    /**
     * Returns the count of trades journaled today.
     */
    public async getTodaysTradeCount(): Promise<number> {
        const result = await this.pool.query(
            `SELECT COUNT(*) AS cnt FROM trade_journal WHERE timestamp::date = CURRENT_DATE`
        );
        return parseInt(result.rows[0].cnt, 10);
    }

    /**
     * Preflight connectivity check — executes SELECT NOW() to verify the DB is reachable.
     * Throws on failure so the preflight sequence can catch and abort.
     */
    public async testConnection(): Promise<void> {
        const result = await this.pool.query('SELECT NOW() AS server_time');
        const serverTime = result.rows[0].server_time;
        console.log(`🧠 [NeonDB] - Connection verified. Server time: ${serverTime}`);
    }

    // ==========================================
    // Prop Firm Account — CRUD Operations
    // ==========================================

    /**
     * Fetches all ACTIVE prop firm accounts from the database.
     */
    public async getActiveAccounts(): Promise<PropAccount[]> {
        const res = await this.pool.query(`SELECT * FROM prop_accounts WHERE status = 'ACTIVE'`);
        return res.rows;
    }

    /**
     * Updates the status of a prop firm account.
     * @param id     - The account row ID
     * @param status - New status: 'ACTIVE', 'PASSED', 'PAYOUT_READY', or 'BLOWN'
     */
    public async updateAccountStatus(id: number, status: PropStatus): Promise<void> {
        await this.pool.query(`UPDATE prop_accounts SET status = $1 WHERE id = $2`, [status, id]);
        console.log(`🏦 [NeonDB] - Account #${id} status updated to: ${status}`);
    }

    /**
     * Updates a prop account's PnL, best day, and days traded after a session.
     * Also runs the FUNDED payout eligibility check.
     *
     * @param id       - The account row ID
     * @param dailyPnl - Today's realized session P&L
     */
    public async updateAccountPnL(id: number, dailyPnl: number): Promise<void> {
        // Increment PnL, calculate best day, and add 1 to days_traded
        await this.pool.query(`
            UPDATE prop_accounts
            SET current_pnl = current_pnl + $1,
                best_day_pnl = GREATEST(best_day_pnl, $1),
                days_traded = days_traded + 1
            WHERE id = $2;
        `, [dailyPnl, id]);

        console.log(`🏦 [NeonDB] - Account #${id} PnL updated: ${dailyPnl >= 0 ? '+' : ''}$${dailyPnl.toFixed(2)}`);

        // Payout Check Logic for FUNDED accounts
        const res = await this.pool.query(`SELECT * FROM prop_accounts WHERE id = $1`, [id]);
        if (res.rows.length > 0) {
            const acc = res.rows[0];
            if (acc.phase === 'FUNDED' && acc.days_traded >= 5 && Number(acc.current_pnl) >= (Number(acc.best_day_pnl) * 2)) {
                await this.updateAccountStatus(id, 'PAYOUT_READY');
                console.log(`🤑 [NeonDB] - MEGA HEIST ALERT: Account ${acc.account_name} is PAYOUT READY!`);
            }
        }
    }

    // ==========================================
    // Telemetry — Async Event Stream
    // ==========================================
    /**
     * Fire-and-forget telemetry logger.
     * Called from Core 4 when a worker posts a TELEMETRY IPC message.
     * Never awaited — DB latency must never block the engine hot path.
     *
     * @param source  — originating worker (e.g. 'MoM', 'Oracle', 'Assistant')
     * @param regime  — market context (e.g. 'Killzone', 'Wilderness', 'Oracle')
     * @param message — human-readable event description
     */
    public async logTelemetry(source: string, regime: string, message: string): Promise<void> {
        try {
            await this.pool.query(
                `INSERT INTO mom_telemetry_logs (source, regime, message, timestamp) VALUES ($1, $2, $3, CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York')`,
                [source, regime, message]
            );
        } catch (err: any) {
            // Silently swallow — telemetry must never crash the engine
            console.warn(`[NeonDB] Telemetry write failed: ${err.message}`);
        }
    }

    /**
     * Creates a telemetry row for a new trade, returning the row id.
     * All subsequent events for this trade are appended via appendTradeEvent().
     */
    public async logTradeEntry(source: string, regime: string, message: string, tradeId: string): Promise<number | null> {
        try {
            const result = await this.pool.query(
                `INSERT INTO mom_telemetry_logs (source, regime, message, trade_id, timestamp) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP AT TIME ZONE 'America/New_York') RETURNING id`,
                [source, regime, message, tradeId]
            );
            return result.rows[0]?.id ?? null;
        } catch (err: any) {
            console.warn(`[NeonDB] Trade entry telemetry failed: ${err.message}`);
            return null;
        }
    }

    /**
     * Appends an event line to an existing trade's telemetry row.
     * Each event is prefixed with an ET timestamp for play-by-play readability.
     */
    public async appendTradeEvent(tradeId: string, event: string): Promise<void> {
        try {
            await this.pool.query(
                `UPDATE mom_telemetry_logs SET message = message || E'\n' || $1 WHERE trade_id = $2`,
                [event, tradeId]
            );
        } catch (err: any) {
            console.warn(`[NeonDB] Trade event append failed: ${err.message}`);
        }
    }

    /**
     * Gracefully closes the connection pool (for clean shutdown).
     */
    public async disconnect(): Promise<void> {
        await this.pool.end();
        console.log('🧠 [NeonDB] - Connection pool closed.');
    }
}

