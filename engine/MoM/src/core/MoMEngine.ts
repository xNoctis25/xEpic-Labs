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
import { DatabentoLiveService } from '../services/DatabentoLiveService';
import { config } from '../config/env';

export class MoMEngine {
    private riskEngine: RiskEngine;
    private executionEngine: ExecutionEngine;
    private broker: TradovateBroker;

    private aggregator: CandleAggregator;
    private smcExpert: SMCExpert;

    // --- Live Execution Services ---
    private oracle: OracleService;
    private ledger: SessionLedger;
    private databento: DatabentoLiveService;

    // --- Persistent Brain ---
    private db: NeonDatabase;
    private evaluationEngine: EvaluationEngine;
    private currentPhase: BotPhase = 'EVALUATION';

    // --- Trade Management ---
    private activePosition: { side: 'BUY' | 'SELL'; entryPrice: number; margin: number; riskBudget: number; qty: number; timestamp: number } | null = null;
    private readonly SL_POINTS = 20; // Must match ExecutionEngine.SL_POINTS

    // Dynamically resolved via ContractBuilder (auto-rollover)
    private symbolToTrade: string;

    constructor(broker: TradovateBroker) {
        this.broker = broker;
        this.riskEngine = new RiskEngine();
        this.db = new NeonDatabase();
        this.executionEngine = new ExecutionEngine(broker, this.db);

        this.smcExpert = new SMCExpert();
        this.oracle = new OracleService();
        this.ledger = new SessionLedger();
        this.evaluationEngine = new EvaluationEngine(this.db);
        this.databento = new DatabentoLiveService();

        // Auto-resolve the active CME front-month contract via ContractBuilder
        this.symbolToTrade = ContractBuilder.getActiveContract('MES');

        // Build 1-minute candles from the tick stream
        this.aggregator = new CandleAggregator(1, this.onCandleComplete.bind(this));

        // Dynamic position monitor — polls Tradovate every 10s to detect bracket fills
        setInterval(() => this.monitorActivePosition(), 10000);
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
     *   3. Tradovate Broker — OAuth authentication
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
            console.log('🔍 [Preflight 3/4] - Tradovate Broker (OAuth)...');
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
        console.log(`🔍  Trading Active Contract: ${this.symbolToTrade}`);
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
     *   4. Preflight 5: Databento data feed verification
     *   5. Stream ticks into the candle aggregator
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
            this.oracle.startScheduler().catch(() => { });
        }
        this.ledger.startBackgroundReconciliation(this.broker);
        this.evaluationEngine.startSchedulers(
            () => this.ledger.getSessionPnL(),
            this.ledger,
            this.smcExpert,
        );

        // 4. Preflight 5: Databento Data Feed — verify 5 ticks before going live
        console.log(`\n🔍 [Preflight 5/5] - Databento Data Feed...`);
        console.log(`📡 Binding Eyes and Hands to exact auto-rolled contract: ${this.symbolToTrade}`);

        let preflightTicks = 0;
        await new Promise<void>((resolve) => {
            this.databento.start('MES.c.0', (tick: Tick) => {
                if (preflightTicks < 5) {
                    preflightTicks++;
                    console.log(`🔥 [Preflight Tick ${preflightTicks}/5] Price: $${tick.price} | Vol: ${tick.volume}`);
                    if (preflightTicks === 5) {
                        console.log(`✅ [Preflight 5/5] - Databento Feed: PASS\n`);
                        resolve(); // Boot sequence continues
                    }
                }

                if (preflightTicks >= 5 && this.riskEngine.canTrade()) {
                    this.aggregator.processTick(tick);
                }
            });
        });

        console.log("🚀 [MoMEngine] - All systems online. Live trading active.\n");
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
        // EOD KILL SWITCH — 15:55 ET Rolling Sweeper
        // ==========================================
        if (MarketClock.isEndOfDayFlatten(candle.timestamp)) {
            console.log(`🚨 [MoMEngine] - EOD SWEEP TRIGGERED (15:55+ ET). Enforcing flat state.`);
            
            // Unconditionally sweep to catch any orphaned local/remote states
            await this.executionEngine.flattenPosition(this.symbolToTrade);
            
            if (this.activePosition) {
                // Force cleanup of local state if it was still stuck open
                this.ledger.releaseMarginAndApplyPnL(this.activePosition.margin, 0); 
                this.riskEngine.updatePnL(0, this.activePosition.riskBudget); 
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
        // All Gates Passed — Execute Trade
        // ==========================================
        const modeLabel = this.currentPhase === 'EVALUATION' ? '📝 PAPER' : '🔥 LIVE';
        const oracleLabel = config.USE_ORACLE ? 'Oracle ✅' : 'Oracle ⏭️';
        console.log(`✅ [MoMEngine] - Gates passed [${modeLabel}]: ${oracleLabel} Sizer ✅ (${sizing.symbolRoot} × ${sizing.qty}) Phase ✅ → Executing ${signal}`);

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
                        timestamp: Date.now(),
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

    private async monitorActivePosition(): Promise<void> {
        if (!this.activePosition) return;
        
        // Wait at least 15 seconds after entry to avoid polling before broker registers it
        if (Date.now() - this.activePosition.timestamp < 15000) return;

        try {
            const netPos = await this.broker.getNetPositionQty(this.symbolToTrade);
            
            if (netPos === 0) {
                console.log(`✅ [MoMEngine] - Position Monitor: Tradovate targets hit (Position flat). Releasing brain.`);
                await this.onPositionClosed(this.activePosition.entryPrice, 0); // P&L handled inherently by Ghost Sync
            }
        } catch (e) { }
    }
}
