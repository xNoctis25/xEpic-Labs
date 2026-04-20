import { RiskEngine } from './RiskEngine';
import { ExecutionEngine } from './ExecutionEngine';
import { EvaluationEngine } from './EvaluationEngine';
import { PositionSizer, ES_DAY_MARGIN, MES_DAY_MARGIN } from './PositionSizer';
import { ContractBuilder } from '../utils/ContractBuilder';
import { MarketClock } from './MarketClock';
import { CandleAggregator, Candle, Tick } from '../market/CandleAggregator';
import { SMCExpert } from '../experts/SMCExpert';
import { TradovateBroker } from '../brokers/TradovateBroker';
import { OracleService } from '../services/OracleService';
import { SessionLedger } from '../services/SessionLedger';
import { NeonDatabase, BotPhase } from '../services/NeonDatabase';
import { config } from '../config/env';
import { Level2DataStore } from '../workers/Level2DataStore';
import { DOMExpert } from '../experts/DOMExpert';

export class MoMEngine {
    private riskEngine: RiskEngine;
    private executionEngine: ExecutionEngine;
    private broker: TradovateBroker;
    
    private aggregator: CandleAggregator;
    private smcExpert: SMCExpert;
    private domExpert: DOMExpert;

    // --- Live Execution Services ---
    private oracle: OracleService;
    private ledger: SessionLedger;

    // --- Persistent Brain ---
    private db: NeonDatabase;
    private evaluationEngine: EvaluationEngine;
    private currentPhase: BotPhase = 'EVALUATION';

    // --- Level 2 DOM Data Store (Phase 2 — Core 2 Worker) ---
    private level2DataStore: Level2DataStore | null = null;

    // --- Trade Management ---
    private activePosition: { side: 'BUY' | 'SELL'; entryPrice: number; margin: number; riskBudget: number; qty: number } | null = null;
    private readonly SL_POINTS = 20; // Must match ExecutionEngine.SL_POINTS

    // Dynamically resolved via ContractBuilder (auto-rollover)
    private symbolToTrade: string;

    constructor(broker: TradovateBroker) {
        this.broker = broker;
        this.riskEngine = new RiskEngine();
        this.db = new NeonDatabase();
        this.executionEngine = new ExecutionEngine(broker, this.db);
        
        this.smcExpert = new SMCExpert();
        this.domExpert = new DOMExpert();
        this.oracle = new OracleService();
        this.ledger = new SessionLedger();
        this.evaluationEngine = new EvaluationEngine(this.db);

        // Auto-resolve the active CME front-month contract via ContractBuilder
        this.symbolToTrade = ContractBuilder.getActiveContract(config.INDICES);

        // Build 1-minute candles from the tick stream
        this.aggregator = new CandleAggregator(1, this.onCandleComplete.bind(this));
    }

    // ==========================================
    // PREFLIGHT CHECK — Sequential System Verification
    // ==========================================
    /**
     * Runs a strict sequential preflight check before any trading begins.
     * Each subsystem is tested in isolation. If ANY check fails, the process exits.
     *
     * Sequence:
     *   1. Neon Postgres — connectivity + schema + state load
     *   2. Oracle (FMP API) — fetch today's economic events
     *   3. Tradovate Broker — OAuth authentication + WebSocket
     *   4. Session Ledger — balance sync from broker
     *
     * Returns the current BotPhase from the database.
     */
    private async runPreflightCheck(): Promise<BotPhase> {
        console.log('\n🔍 ═══════════════════════════════════════════');
        console.log('🔍  M.o.M PREFLIGHT CHECK — System Verification');
        console.log('🔍 ═══════════════════════════════════════════\n');

        // --- Check 1: Neon Postgres ---
        try {
            console.log('🔍 [Preflight 1/4] - Neon Postgres...');
            await this.db.initialize();
            await this.db.testConnection();
            console.log('✅ [Preflight 1/4] - Neon Postgres: PASS\n');
        } catch (error: any) {
            console.error(`❌ PREFLIGHT FAILED: Neon Postgres — ${error.message}`);
            process.exit(1);
        }

        // --- Check 2: Oracle (FMP API) ---
        if (config.USE_ORACLE) {
            try {
                console.log('🔍 [Preflight 2/4] - Oracle (FMP Economic Calendar)...');
                await this.oracle.fetchTodaysEvents();
                console.log('✅ [Preflight 2/4] - Oracle: PASS\n');
            } catch (error: any) {
                console.error(`❌ PREFLIGHT FAILED: Oracle (FMP API) — ${error.message}`);
                process.exit(1);
            }
        } else {
            console.log('🔍 [Preflight 2/4] - Oracle: BYPASSED (USE_ORACLE=false)\n');
        }

        // --- Check 3: Tradovate Broker ---
        try {
            console.log('🔍 [Preflight 3/4] - Tradovate Broker (OAuth + WebSocket)...');
            const connected = await this.broker.connect();
            if (!connected) {
                throw new Error('Broker returned false from connect().');
            }
            console.log('✅ [Preflight 3/4] - Tradovate Broker: PASS\n');
        } catch (error: any) {
            console.error(`❌ PREFLIGHT FAILED: Tradovate Broker — ${error.message}`);
            process.exit(1);
        }

        // --- Check 4: Session Ledger (Balance API) ---
        try {
            console.log('🔍 [Preflight 4/4] - Session Ledger (Balance Sync)...');
            await this.ledger.initialize(this.broker);
            console.log('✅ [Preflight 4/4] - Session Ledger: PASS\n');
        } catch (error: any) {
            console.error(`❌ PREFLIGHT FAILED: Session Ledger — ${error.message}`);
            process.exit(1);
        }


        // --- Load Phase from DB ---
        this.currentPhase = await this.evaluationEngine.initialize();

        console.log('🔍 ═══════════════════════════════════════════');
        console.log('🔍  PREFLIGHT COMPLETE — All Systems Verified');
        console.log(`🔍  Trading Active Contract: ${this.symbolToTrade} (${ContractBuilder.getContractDescription(config.INDICES)})`);
        console.log('🔍 ═══════════════════════════════════════════\n');

        return this.currentPhase;
    }

    // ==========================================
    // BOOT SEQUENCE
    // ==========================================
    /**
     * Main boot sequence:
     *   1. Run preflight checks (exits on failure)
     *   2. Check lifecycle phase (exit if BACKTEST)
     *   3. Start background services (crons, ghost sync)
     *   4. Subscribe to live market data
     */
    public async start(): Promise<void> {
        console.log("🚀 [MoMEngine] - Central Orchestrator Online. Booting sub-systems...\n");
        
        // 1. Preflight — sequential system verification (exits on failure)
        const phase = await this.runPreflightCheck();

        // 2. Phase Gate — BACKTEST = no live execution
        if (phase === 'BACKTEST') {
            console.error("🔴 [MoMEngine] - Bot is in BACKTEST mode. Aborting live connection.");
            console.error("🔴 [MoMEngine] - M.o.M must pass a new backtest before re-entering EVALUATION.");
            await this.db.disconnect();
            process.exit(0);
        }

        const modeLabel = phase === 'EVALUATION' ? '📝 PAPER TRADING' : '🔥 LIVE EXECUTION';
        console.log(`🚀 [MoMEngine] - Phase: ${phase} — ${modeLabel}`);

        // 3. Start background services
        if (config.USE_ORACLE) {
            this.oracle.startScheduler().catch(() => {}); // Cron already fetched in preflight
        }
        this.ledger.startBackgroundReconciliation(this.broker);
        this.evaluationEngine.startSchedulers(
            () => this.ledger.getSessionPnL(),
            this.ledger,
            this.smcExpert,
        );

        console.log("🚀 [MoMEngine] - All systems online. Subscribing to market data...\n");

        // 4. Subscribe to live ticks and pipe into the candle aggregator
        this.broker.subscribeMarketData(this.symbolToTrade, (tick: Tick) => {
            if (this.riskEngine.canTrade()) {
                this.aggregator.processTick(tick);
            }
        });

        // 5. Conditional Level 2 DOM — Worker Thread on Core 2 (Triple Threat)
        // Worker shares the main thread's token (single-token architecture)
        if (config.USE_DOM_EXPERT) {
            console.log("📊 [MoMEngine] - DOM Expert ENABLED. Launching Level 2 Data Store on Core 2...");
            this.level2DataStore = new Level2DataStore(
                this.broker.getAccessToken(),
                this.symbolToTrade,
            );

            // Inject snapshot reader into DOMExpert for anti-spoof re-reads
            this.domExpert.setSnapshotReader(() => this.level2DataStore?.readSnapshot() ?? null);

            // Phase 2 verification: periodic SAB read to confirm data flow
            this.startDOMVerificationLogger();
        } else {
            console.log("📊 [MoMEngine] - DOM Expert DISABLED. Running SMC-only playbook.");
        }
    }

    // ==========================================
    // PHASE 2 VERIFICATION — SAB Read Confirmation
    // ==========================================
    /**
     * Periodically reads the SharedArrayBuffer from the main thread to confirm
     * the Level2Worker on Core 2 is writing DOM data successfully.
     *
     * This is a TEMPORARY verification logger. Phase 3 will replace it with
     * the DOMExpert consuming the SAB directly.
     */
    private startDOMVerificationLogger(): void {
        setInterval(() => {
            if (!this.level2DataStore) return;
            const snapshot = this.level2DataStore.readSnapshot();
            if (snapshot && snapshot.bids.length > 0 && snapshot.offers.length > 0) {
                console.log(
                    `📊 [Level2 SAB Read] - Best Bid: ${snapshot.bids[0].price} (${snapshot.bids[0].size}) ` +
                    `| Best Ask: ${snapshot.offers[0].price} (${snapshot.offers[0].size}) ` +
                    `| Depth: ${snapshot.bids.length}×${snapshot.offers.length}`
                );
            } else if (!snapshot) {
                console.log(`📊 [Level2 SAB Read] - No data yet (worker may still be connecting).`);
            }
        }, 10000); // Every 10 seconds
    }

    // ==========================================
    // CANDLE PROCESSING — Pre-Trade Gate Pipeline
    // ==========================================
    /**
     * Called every time a 1-minute candle completes.
     * Updates excursion tracking for active trades, then runs gate pipeline.
     */
    private async onCandleComplete(candle: Candle): Promise<void> {
        console.log(`📊 [MoMEngine] - 1M Candle Complete [${this.symbolToTrade}]: O:${candle.open} H:${candle.high} L:${candle.low} C:${candle.close}`);

        // ==========================================
        // EOD KILL SWITCH — 15:55 ET Margin Protection
        // ==========================================
        // Must fire BEFORE any gate logic. Tradovate penalizes positions
        // held past the intraday close. Flatten immediately.
        if (MarketClock.isEndOfDayFlatten(candle.timestamp)) {
            if (this.activePosition) {
                console.log(`🚨 [MoMEngine] - EOD FLATTEN TRIGGERED (15:55 ET). Liquidating open positions.`);
                await this.executionEngine.flattenPosition(
                    this.symbolToTrade,
                    this.activePosition.side,
                    this.activePosition.qty,
                );

                // Force cleanup of local state
                this.ledger.releaseMarginAndApplyPnL(this.activePosition.margin, 0); // PnL syncs later via broker reconciliation
                this.riskEngine.updatePnL(0, this.activePosition.riskBudget); // Register $0 so daily tracker stays accurate
                this.activePosition = null;
            }
            return; // Do not process any new signals for the rest of the day
        }

        // Update MFE/MAE excursion tracking if a trade is active
        this.executionEngine.updateExcursion(candle);

        // Feed every candle to the expert regardless of gates (indicators must stay aligned)
        const signal = this.smcExpert.analyze(candle);

        // ==========================================
        // SMC Heartbeat — Verbose Debug Log
        // ==========================================
        if (config.VERBOSE_SMC_LOGGING) {
            const hb = this.smcExpert.lastHeartbeat;
            const etTime = new Date(candle.timestamp).toLocaleTimeString('en-US', {
                timeZone: 'America/New_York',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false,
            });
            console.log(
                `[SMC Heartbeat] ${etTime} ET` +
                ` | O: ${candle.open} H: ${candle.high} L: ${candle.low} C: ${candle.close}` +
                ` | Trend: ${hb.trend}` +
                ` | FVG: ${hb.fvg}` +
                ` | Decision: ${hb.decision}`
            );
        }

        // Only process BUY/SELL signals — skip HOLD
        if (signal === 'HOLD') return;

        // Already in a position — do not open a second one
        if (this.activePosition) return;

        // ==========================================
        // Pre-Trade Gate 0: Lifecycle Phase
        // ==========================================
        this.currentPhase = this.evaluationEngine.getPhase();
        if (this.currentPhase === 'BACKTEST') {
            console.log(`🔴 [MoMEngine] - Signal IGNORED: Phase is BACKTEST. Execution blocked.`);
            return;
        }

        // ==========================================
        // Pre-Trade Gate 1: Oracle (News Blackout)
        // ==========================================
        if (config.USE_ORACLE && this.oracle.isNewsBlockoutActive(Date.now())) {
            console.log(`🔮 [MoMEngine] - Signal IGNORED: News blackout active (±15 min window).`);
            // Log rejection to SMCExpert for EoDR
            this.smcExpert.dailyRejectedSetups.push(
                `${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected (Oracle News Blockout).`
            );
            return;
        }

        // ==========================================
        // Pre-Trade Gate 2: PositionSizer (Dynamic Risk Budget)
        // ==========================================
        const buyingPower = this.ledger.getAvailableBuyingPower();
        const sizing = PositionSizer.calculate(buyingPower, this.SL_POINTS, config.INDICES);
        if (!sizing) {
            console.log(`💰 [MoMEngine] - Signal IGNORED: Account cannot afford the trade. Buying Power: $${buyingPower.toFixed(2)}`);
            return;
        }

        // Calculate required margin based on sizer output
        const marginPerContract = sizing.symbolRoot === 'ES' ? ES_DAY_MARGIN : MES_DAY_MARGIN;
        const totalMarginRequired = sizing.qty * marginPerContract;

        if (!this.ledger.hasSufficientMargin(totalMarginRequired)) {
            console.log(`💰 [MoMEngine] - Signal IGNORED: Insufficient margin ($${buyingPower.toFixed(2)} < $${totalMarginRequired} for ${sizing.qty}× ${sizing.symbolRoot}).`);
            return;
        }

        // Resolve the exact contract symbol for the sizer's chosen root (ES or MES)
        const tradeSymbol = ContractBuilder.getActiveContract(sizing.symbolRoot);

        // ==========================================
        // Pre-Trade Gate 3: DOM Expert (Order Book + Anti-Spoof Confirmation)
        // ==========================================
        // Only active when USE_DOM_EXPERT is true. Uses 3-second anti-spoof
        // confirmation to ensure institutional liquidity holds steady.
        let domApproved = true; // Default: approved (bypassed when flag is off)
        if (config.USE_DOM_EXPERT) {
            domApproved = await this.domExpert.confirmSetup(signal);
            if (!domApproved) {
                // Log rejection to SMCExpert for EoDR
                this.smcExpert.dailyRejectedSetups.push(
                    `${new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' })}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected (DOM Anti-Spoof failed).`
                );
                return;
            }
        }

        // ==========================================
        // All Gates Passed — Execute Trade
        // ==========================================
        const modeLabel = this.currentPhase === 'EVALUATION' ? '📝 PAPER' : '🔥 LIVE';
        const oracleLabel = config.USE_ORACLE ? 'Oracle ✅' : 'Oracle ⏭️';
        const domLabel = config.USE_DOM_EXPERT ? 'DOM ✅' : 'DOM ⏭️';
        console.log(`✅ [MoMEngine] - Gates passed [${modeLabel}]: ${oracleLabel} Sizer ✅ (${sizing.symbolRoot} × ${sizing.qty}) ${domLabel} Phase ✅ → Executing ${signal}`);

        // Reserve margin from the ledger
        this.ledger.reserveMargin(totalMarginRequired);

        // Fire the bracket order via the ExecutionEngine
        this.executionEngine.executeBracket(tradeSymbol, candle.close, signal, sizing.qty)
            .then((orderId) => {
                if (orderId) {
                    this.activePosition = {
                        side: signal,
                        entryPrice: candle.close,
                        margin: totalMarginRequired,
                        riskBudget: sizing.riskBudget,
                        qty: sizing.qty,
                    };
                    console.log(`📊 [MoMEngine] - Position OPEN [${modeLabel}]: ${signal} @ ${candle.close} | ${sizing.symbolRoot} × ${sizing.qty} | Margin: $${totalMarginRequired} | Order: ${orderId}`);
                } else {
                    this.ledger.releaseMarginAndApplyPnL(totalMarginRequired, 0);
                    console.error(`🔴 [MoMEngine] - Bracket order failed. Margin released.`);
                }
            })
            .catch(() => {
                this.ledger.releaseMarginAndApplyPnL(totalMarginRequired, 0);
            });
    }

    // ==========================================
    // POSITION LIFECYCLE
    // ==========================================
    /**
     * Called by the trade management system when a position is closed.
     * Grades the trade, journals it, releases margin, and updates P&L.
     *
     * @param exitPrice   - The price at which the position was closed
     * @param realizedPnL - The dollar P&L of the trade
     */
    public async onPositionClosed(exitPrice: number, realizedPnL: number): Promise<void> {
        if (!this.activePosition) return;

        // Grade and journal the trade (MFE/MAE → Neon Postgres)
        await this.executionEngine.gradeAndJournalTrade(exitPrice, realizedPnL);

        // Release margin back to the ledger with P&L applied
        this.ledger.releaseMarginAndApplyPnL(this.activePosition.margin, realizedPnL);

        // Update the risk engine's daily P&L tracker (pass riskBudget for dynamic halt limit)
        this.riskEngine.updatePnL(realizedPnL, this.activePosition.riskBudget);

        const pnlStr = realizedPnL >= 0 ? `+$${realizedPnL.toFixed(2)}` : `-$${Math.abs(realizedPnL).toFixed(2)}`;
        console.log(`📊 [MoMEngine] - Position closed: ${pnlStr} | Buying Power: $${this.ledger.getAvailableBuyingPower().toFixed(2)}`);

        this.activePosition = null;
    }
}
