/**
 * index.ts — Master Thread (Core 4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Core 1 │ MoMEngine       → SMC signal evaluation + trade execution
 *  Core 2 │ AssistantWorker → Tactical Overwatch + Triple-Sweep P2
 *  Core 3 │ Oracle          → Databento dual-feed + Macro Radar + Calendar + WSS
 *  Core 4 │ THIS FILE       → Boot, broker I/O, ExecutionEngine, lifecycle
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─── Global ET Timestamp Prefixer (must be first import) ─────────────────────
import './utils/etLogger';

// Suppress Node.js deprecation warnings (pg SSL, etc.)
process.env.NODE_NO_WARNINGS = '1';

import * as dotenv from 'dotenv';
import * as path   from 'path';
import { Worker, MessageChannel } from 'worker_threads';

import { TradovateBroker }                  from './brokers/TradovateBroker';
import { NeonDatabase, PropAccount }                from './services/NeonDatabase';
import { ExecutionEngine }                  from './core/ExecutionEngine';
import { SessionLedger }                    from './services/SessionLedger';
import { PositionSizer, ES_DAY_MARGIN, MES_DAY_MARGIN } from './core/PositionSizer';
import { RiskEngine }                    from './core/RiskEngine';
import { EvaluationEngine }              from './core/EvaluationEngine';
import { MarketClock }                   from './core/MarketClock';
import { HaltManager }                   from './services/HaltManager';
import { getNextCmeOpen }                from './utils/TimeUtils';
import { ContractBuilder }               from './utils/ContractBuilder';
import { config }                           from './config/env';

dotenv.config();

const tradeSymbol = ContractBuilder.getActiveContract(config.INDICES);

const maxContracts = config.MAX_CONTRACTS;
const playbookLabel = maxContracts > 0
    ? `Prop Firm (max ${maxContracts} contracts)`
    : 'Cash Account';
const tradingMode = config.TRADING_MODE === 'LIVE' ? '🟢 LIVE' : '🟡 PAPER';

// ─── Global Services ─────────────────────────────────────────────────────────
const broker          = new TradovateBroker();
const db              = new NeonDatabase();
const executionEngine = new ExecutionEngine(broker, db);
const ledger          = new SessionLedger();
const riskEngine      = new RiskEngine();
const haltManager     = new HaltManager(db);
const evalEngine      = new EvaluationEngine(db, haltManager);
let positionMonitor: NodeJS.Timeout | null = null;

// ─── Playbook State (DB-driven, polled every 30s) ─────────────────────────────
let activePlaybook: 'PROP_FIRM' | 'CASH_ACCOUNT' = 'PROP_FIRM';
let propAccounts: PropAccount[] = [];
let propMinBuffer = 0;

async function pollPlaybook(): Promise<void> {
    try {
        const cfg = await db.getEngineConfig();
        activePlaybook = cfg.active_playbook;
        if (activePlaybook === 'PROP_FIRM') {
            propAccounts = await db.getActiveAccounts();
            if (propAccounts.length > 0) {
                propMinBuffer = Math.min(...propAccounts.map(acc => {
                    const bal = Number(acc.account_balance ?? acc.account_size);
                    return Number(acc.max_loss_limit) + (bal - Number(acc.account_size));
                }));
            } else {
                propMinBuffer = 0;
                console.warn('[M.o.M] ⚠️  PROP_FIRM mode — NO ACTIVE ACCOUNTS. Entries will be blocked.');
            }
        } else {
            propAccounts = [];
            propMinBuffer = 0;
        }
    } catch (err: any) {
        console.warn(`[M.o.M] ⚠️ Playbook poll failed: ${err.message}`);
    }
}

// ─── Worker handles ──────────────────────────────────────────────────────────
let momWorker:       Worker;
let assistantWorker: Worker;
let oracle:          Worker;

// ─── Resolve worker path ─────────────────────────────────────────────────────
const isTsNode = __filename.endsWith('.ts');
function workerPath(name: string): string {
    const ext = isTsNode ? '.ts' : '.js';
    return path.join(__dirname, 'core', `${name}${ext}`);
}
const workerOpts = isTsNode ? { execArgv: ['-r', 'ts-node/register'] } : {};

// ─── Test trade lifecycle ────────────────────────────────────────────────────

// Active trade context — tracks entry details for PnL calculation on close
interface ActiveTradeCtx {
    symbol:     string;
    direction:  'BUY' | 'SELL';
    entryPrice: number;
    stopPrice:  number;
    qty:        number;
    margin:     number;
    source:     string;   // SMC
    entryTs:    number;
    tradeId?:   string;   // correlation key for telemetry consolidation
}
let activeTradeCtx: ActiveTradeCtx | null = null;

let testTradeResolve: (() => void) | null = null;

// ─── Worker error handlers ───────────────────────────────────────────────────
function onWorkerError(name: string) {
    return (err: Error) => console.error(`[M.o.M] ❌ ${name} crashed: ${err.message}`);
}
function onWorkerExit(name: string) {
    return (code: number) => {
        if (code !== 0) console.error(`[M.o.M] ❌ ${name} exited (code ${code})`);
    };
}

// ─── Broker flat check ───────────────────────────────────────────────────────
async function checkIsFlat(symbol: string): Promise<boolean> {
    const [netPos, stopCount] = await Promise.all([
        broker.getNetPositionQty(symbol),
        broker.getWorkingStopOrders(symbol),
    ]);
    return netPos === 0 && stopCount === 0;
}

// --- Ledger reconciliation on trade close ---
async function reconcileLedgerOnClose(reason: string): Promise<void> {
    if (!activeTradeCtx) return;
    const ctx = activeTradeCtx;
    activeTradeCtx = null;

    try {
        // Query broker for real post-trade balance
        const postBalance = await broker.getCashBalance();
        const preBalance  = ledger.getAvailableBuyingPower() + ledger.getReservedMargin();
        const realizedPnL = postBalance - preBalance;

        ledger.releaseMarginAndApplyPnL(ctx.margin, realizedPnL);

        // Update RiskEngine daily P&L tracker
        const riskBudget = ledger.getAvailableBuyingPower() * (config.RISK / 100);
        riskEngine.updatePnL(realizedPnL, riskBudget);

        // Check for Global Daily Profit Limit Halt
        if (ledger.getSessionPnL() >= config.DAILY_PROFIT_LIMIT) {
            const nextOpen = getNextCmeOpen();
            await haltManager.triggerHalt('DAILY_PROFIT', nextOpen);
            console.log(`\n🛑 [M.o.M] DAILY PROFIT LIMIT HIT ($${ledger.getSessionPnL().toFixed(2)}). Halted until next CME Open.`);
        }

        const pnlStr = realizedPnL >= 0 ? `+$${realizedPnL.toFixed(2)}` : `-$${Math.abs(realizedPnL).toFixed(2)}`;
        const duration = ((Date.now() - ctx.entryTs) / 60000).toFixed(1);
        console.log(
            `[M.o.M] ${realizedPnL >= 0 ? '✅' : '❌'} Trade Closed | ${ctx.symbol} ${ctx.direction} | ` +
            `Entry: ${ctx.entryPrice} | PnL: ${pnlStr} | Duration: ${duration}min | Reason: ${reason} | Src: ${ctx.source}`
        );

        const etTime = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
        if (ctx.tradeId) {
            void db.appendTradeEvent(ctx.tradeId,
                `[${etTime} ET] CLOSED: PnL: ${pnlStr} | Qty: ${ctx.qty} | Duration: ${duration}min | Reason: ${reason} | Src: ${ctx.source}`
            );
        } else {
            void db.logTelemetry('Core4', 'Execution',
                `CLOSED: ${ctx.symbol} ${ctx.direction} | Entry: ${ctx.entryPrice} | PnL: ${pnlStr} | Qty: ${ctx.qty} | Duration: ${duration}min | Reason: ${reason} | Src: ${ctx.source}`
            );
        }

        // Journal the trade to Neon (skip test trades)
        if (!reason.includes('TEST_TRADE')) {
            const dollarPerPoint = ctx.symbol.startsWith('MES') ? 5 : 50;
            const exitPrice = ctx.direction === 'BUY'
                ? ctx.entryPrice + (realizedPnL / (ctx.qty * dollarPerPoint))
                : ctx.entryPrice - (realizedPnL / (ctx.qty * dollarPerPoint));
            const durationSeconds = Math.round((Date.now() - ctx.entryTs) / 1000);
            const initialRiskPerContract = Math.abs(ctx.entryPrice - ctx.stopPrice) * dollarPerPoint;
            const initialRiskTotal = initialRiskPerContract * ctx.qty;
            await executionEngine.gradeAndJournalTrade(exitPrice, realizedPnL, durationSeconds, initialRiskTotal);
        }

        // PROP_FIRM: write realized PnL back to all active accounts after every close
        if (activePlaybook === 'PROP_FIRM' && propAccounts.length > 0) {
            const isLive = config.TRADING_MODE === 'LIVE';
            for (const acc of propAccounts) {
                await db.patchAccountBalance(acc.id, realizedPnL, ctx.qty, ctx.symbol, isLive);
            }
            await pollPlaybook(); // refresh buffer immediately after write-back
        }

        // Push trade-close notification to dashboard
        void db.pushNotification('TRADE_CLOSED',
            `💰 CLOSED ${pnlStr} | ${ctx.qty}×${ctx.symbol} ${ctx.direction} | ${reason}`
        );

    } catch (err: any) {
        // Fallback: release margin with 0 PnL, ghost sync will correct
        ledger.releaseMarginAndApplyPnL(ctx.margin, 0);
        console.warn(`[M.o.M] Ledger reconcile failed: ${err.message} - ghost sync will correct.`);
    }
}

// ─── Trade command dispatcher ────────────────────────────────────────────────
async function handleTradeCommand(
    payload: Record<string, unknown>,
    source:  'MoMEngine' | 'AssistantWorker',
): Promise<void> {
    const action = payload.action as string;

    switch (action) {

        case 'TEST_ENTER': {
            const symbol = payload.symbol as string;
            const price  = payload.price as number;
            console.log(`[M.o.M] 🧪 Test Trade: 3x ${symbol} @ ${price}`);
            await executionEngine.executeBracket(symbol, price, 'BUY', 3);
            if (positionMonitor) clearInterval(positionMonitor);
            positionMonitor = setInterval(async () => {
                try {
                    const net = await broker.getNetPositionQty(symbol);
                    if (net === 0) {
                        clearInterval(positionMonitor!); positionMonitor = null;
                        momWorker.postMessage({ type: 'position_closed', reason: 'NATURAL_BRACKET_FILL' });
                    }
                } catch (e: any) {
                    console.warn(`[M.o.M] Position monitor: ${e.message}`);
                }
            }, 5000);
            break;
        }

        case 'ENTER': {
            const symbol    = payload.symbol    as string;
            const price     = payload.price     as number;
            const rawDir    = payload.direction as string;
            const side: 'BUY' | 'SELL' = (rawDir === 'LONG' || rawDir === 'BUY') ? 'BUY' : 'SELL';
            const src       = payload.source as string || 'SMC';
            const conf      = payload.confidence as number || 0;

            console.log(`[M.o.M] 🔥 ENTER ${side} ${symbol} @ ${price} | Src: ${src} | Prob: ${conf}%`);

            // RiskEngine daily halt gate
            if (!riskEngine.canTrade()) {
                console.warn('[M.o.M] ❌ Trade BLOCKED — RiskEngine daily halt (3x stop-out limit).');
                void db.logTelemetry('Core4', 'Risk', 'DAILY_HALT: Trade blocked by RiskEngine.');
                void db.pushNotification('TRADE_REJECTED', '🔴 Trade BLOCKED — RiskEngine daily halt (3x stop-out)');
                return;
            }

            // PROP_FIRM gate: block entry if no active accounts
            if (activePlaybook === 'PROP_FIRM' && propAccounts.length === 0) {
                const skipMsg = '🔕 Trade SKIPPED — No active prop accounts. PROP_FIRM playbook requires at least 1 ACTIVE account.';
                console.warn(`[M.o.M] ${skipMsg}`);
                void db.pushNotification('TRADE_SKIPPED', skipMsg);
                return;
            }

            // Calculate actual stop distance for position sizing
            const entryPrice = price;
            const actualStopPrice = payload.stopPrice as number | undefined;
            const slDistance = actualStopPrice
                ? Math.abs(entryPrice - actualStopPrice)
                : 20;  // fallback only if no stop provided

            // ── Prop Firm Context (from polled playbook state — uses min buffer across all active accounts) ──
            let propOverride;
            if (activePlaybook === 'PROP_FIRM' && propAccounts.length > 0) {
                propOverride = {
                    phase:           propAccounts[0].phase,
                    riskProfile:     propAccounts[0].risk_profile,
                    currentBuffer:   propMinBuffer,
                    maxLossLimit:    Number(propAccounts[0].max_loss_limit),
                    maxPositionSize: Number(propAccounts[0].max_position_size),
                };
            }

            const sizing = PositionSizer.calculate(
                ledger.getAvailableBuyingPower(), slDistance, config.INDICES, propOverride
            );
            if (!sizing) {
                console.warn('[M.o.M] ❌ Trade BLOCKED — insufficient buying power.');
                return;
            }

            const marginPerContract = sizing.symbolRoot === 'ES' ? ES_DAY_MARGIN : MES_DAY_MARGIN;
            ledger.reserveMargin(sizing.qty * marginPerContract);

            // Generate trade ID for telemetry consolidation
            const tradeId = `${symbol}-${Date.now()}`;

            // Store trade context for PnL reconciliation on close
            activeTradeCtx = {
                symbol, direction: side, entryPrice: price,
                stopPrice: (payload.stopPrice as number) || (side === 'BUY' ? price - 20 : price + 20),
                qty: sizing.qty, margin: sizing.qty * marginPerContract,
                source: src, entryTs: Date.now(), tradeId,
            };

            await executionEngine.executeBracket(symbol, price, side, sizing.qty, payload.stopPrice as number | undefined);
            // Push trade-entry notification to dashboard
            void db.pushNotification('TRADE_ENTERED',
                `🟢 ${side} ${sizing.qty}×${symbol} @ ${price} | Src: ${src} | Prob: ${conf}%`
            );
            if (positionMonitor) clearInterval(positionMonitor);
            let failsafeInjected = false;
            const monitorStartTs = Date.now();
            const FAILSAFE_GRACE_MS = 15_000;  // 15s grace for OSO stops to propagate
            positionMonitor = setInterval(async () => {
                try {
                    const net = await broker.getNetPositionQty(symbol);
                    if (net === 0) {
                        clearInterval(positionMonitor!); positionMonitor = null;
                        console.log(`[M.o.M] ✅ Position FLAT — bracket filled.`);
                        await reconcileLedgerOnClose('NATURAL_BRACKET_FILL');
                        momWorker.postMessage({ type: 'position_closed', reason: 'NATURAL_BRACKET_FILL' });
                        return;
                    }

                    // ── Naked Position Failsafe ──────────────────────────────
                    const stopCount = await broker.getWorkingStopOrders(symbol);
                    if (stopCount < 0) return;  // query failed — skip this cycle
                    if (stopCount > 0) { failsafeInjected = false; return; }  // protected ✅

                    // NAKED: position exists but no stops
                    if (failsafeInjected) return;  // already injected, waiting to register

                    // Grace period: OSO stops take time to propagate on Tradovate
                    if (Date.now() - monitorStartTs < FAILSAFE_GRACE_MS) return;

                    const exitAction: 'Buy' | 'Sell' = side === 'BUY' ? 'Sell' : 'Buy';
                    const stopPrice = side === 'BUY'
                        ? price - 20  // hard stop at SL_POINTS
                        : price + 20;

                    console.warn(`🛡️ [FAILSAFE] Naked position! ${net}x ${symbol}, 0 stops. Injecting emergency stop @ ${stopPrice}`);
                    if (activeTradeCtx?.tradeId) {
                        const etNow = new Date().toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
                        void db.appendTradeEvent(activeTradeCtx.tradeId, `[${etNow} ET] FAILSAFE: Naked ${net}x — injecting stop @ ${stopPrice}`);
                    } else {
                        void db.logTelemetry('Core4', 'Risk', `NAKED_FAILSAFE: ${symbol} ${net}x — injecting stop @ ${stopPrice}`);
                    }
                    await broker.placeProtectiveStop(symbol, exitAction, Math.abs(net), stopPrice);
                    failsafeInjected = true;
                } catch (e: any) {
                    console.warn(`[M.o.M] Position monitor: ${e.message}`);
                }
            }, 5000);
            break;
        }

        case 'FLATTEN_ALL': {
            const symbol = payload.symbol as string | undefined;
            const reason = payload.reason as string | undefined;
            console.log(`[M.o.M] 🧹 FLATTEN ${symbol ?? 'ALL'} — ${reason ?? source}`);
            if (positionMonitor) { clearInterval(positionMonitor); positionMonitor = null; }
            if (symbol) {
                await executionEngine.flattenPosition(symbol);
                momWorker.postMessage({ type: 'position_closed', reason: reason ?? 'MANUAL_FLATTEN' });
                await reconcileLedgerOnClose(reason ?? 'MANUAL_FLATTEN');
            } else {
                await broker.cancelAllWorkingOrders();
            }
            break;
        }

        case 'CANCEL_ALL_ORDERS': {
            await broker.cancelAllWorkingOrders();
            break;
        }

        case 'MOVE_STOP_TO_BE':
        case 'TIGHTEN_STOP': {
            const symbol    = payload.symbol    as string;
            const stopPrice = payload.stopPrice as number;
            const rawDir    = (payload.direction as string | undefined) ?? 'LONG';
            const exitAction: 'Buy' | 'Sell' = (rawDir === 'LONG' || rawDir === 'BUY') ? 'Sell' : 'Buy';
            console.log(`[M.o.M] 🛑 ${action} ${symbol} → ${stopPrice}`);

            // Query actual net position — stops must cover ALL remaining contracts
            try {
                const netQty = await broker.getNetPositionQty(symbol);
                const absQty = Math.abs(netQty);
                if (absQty === 0) {
                    console.warn(`[M.o.M] ⚠️ ${action}: position already flat — skipping stop.`);
                    break;
                }
                // Cancel existing stops first, then place fresh one for correct qty
                await broker.cancelAllWorkingOrders();
                await broker.placeProtectiveStop(symbol, exitAction, absQty, stopPrice);
                console.log(`[M.o.M] ✅ ${action}: ${absQty}x ${symbol} stop @ ${stopPrice}`);
            } catch (e: any) {
                console.error(`[M.o.M] ❌ ${action} failed: ${e.message}`);
            }
            break;
        }

        default:
            console.warn(`[M.o.M] Unknown trade action: ${action}`);
    }
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// ─── BOOT SEQUENCE ───────────────────────────────────────────────────────────
async function boot(): Promise<void> {

    // 0. Market Guard — sleep until CME Globex is open
    const calendarWarning = MarketClock.checkHolidayCalendarExpiry();
    if (calendarWarning) console.warn(`[M.o.M] ${calendarWarning}`);

    while (MarketClock.isMarketClosed()) {
        const et = MarketClock.formatET();
        const reason = MarketClock.isWeekend()
            ? 'Weekend'
            : MarketClock.isHoliday()
                ? 'CME Holiday'
                : 'CME Maintenance';
        console.log(`[M.o.M] 🌙 Market closed (${reason}) — ${et} ET — sleeping 5 min...`);
        await sleep(5 * 60_000);
    }
    console.log(`[M.o.M] ✅ Market open — ${MarketClock.formatET()} ET`);

    // 1. Core Services
    await db.initialize();
    const botState = await db.getState();

    // Poll playbook + active accounts immediately on boot (used by banner + entry gate)
    await pollPlaybook();
    // Re-poll every 30s to pick up Nova playbook switches without restart
    setInterval(() => void pollPlaybook(), 30_000);

    const connected = await broker.connect();
    if (!connected) throw new Error('Broker auth failed');
    console.log('[M.o.M] ✅ Broker authenticated');

    await ledger.initialize(broker);
    ledger.startBackgroundReconciliation(broker);
    console.log(`[M.o.M] ✅ Ledger synced — $${ledger.getAvailableBuyingPower().toFixed(0)} buying power`);

    // Initialize lifecycle state machine + EoDR schedulers
    const phase = await evalEngine.initialize();
    evalEngine.startSchedulers(() => ledger.getSessionPnL(), ledger);
    console.log(`[M.o.M] ✅ EvaluationEngine online — Phase: ${phase}`);

    // 2. Spawn Workers + Wire IPC Mesh
    momWorker       = new Worker(workerPath('MoMEngine'), workerOpts);
    assistantWorker = new Worker(workerPath('AssistantWorker'), workerOpts);
    oracle          = new Worker(workerPath('Oracle'), workerOpts);

    momWorker      .on('error', onWorkerError('MoMEngine'))      .on('exit', onWorkerExit('MoMEngine'));
    assistantWorker.on('error', onWorkerError('AssistantWorker')).on('exit', onWorkerExit('AssistantWorker'));
    oracle         .on('error', onWorkerError('Oracle'))         .on('exit', onWorkerExit('Oracle'));

    const channelOracleMom    = new MessageChannel();
    const channelOracleAssist = new MessageChannel();
    const channelMomAssist    = new MessageChannel();

    momWorker.postMessage(
        { type: 'init', oraclePort: channelOracleMom.port1, assistPort: channelMomAssist.port1 },
        [channelOracleMom.port1, channelMomAssist.port1],
    );
    assistantWorker.postMessage(
        { type: 'init', momPort: channelMomAssist.port2, oraclePort: channelOracleAssist.port1 },
        [channelMomAssist.port2, channelOracleAssist.port1],
    );
    oracle.postMessage(
        { type: 'init', momPort: channelOracleMom.port2, assistPort: channelOracleAssist.port2 },
        [channelOracleMom.port2, channelOracleAssist.port2],
    );

    wireMomHandler();
    wireAssistantHandler();
    wireOracleHandler();

    console.log('[M.o.M] ✅ 4-core mesh online — feeds connecting...');

    // 3. Test trade DISABLED — skip preflight trade validation
    // To re-enable: uncomment the block below and set isTestingTrade = true in MoMEngine.ts
    console.log('[M.o.M] ⏭️  Test trade DISABLED — skipping preflight trade validation');
    /*
    console.log('[M.o.M] 🧪 Awaiting test trade + triple-sweep...');

    const testTradeResult = await new Promise<boolean>((resolve) => {
        testTradeResolve = () => resolve(true);
        setTimeout(() => resolve(false), 60_000);
    });

    if (!testTradeResult) {
        console.error('\n==========================================');
        console.error('  ❌ TEST TRADE FAILED — SYSTEM HALTED');
        console.error('  Triple-sweep did not complete in 60s.');
        console.error('==========================================\n');
        process.exit(1);
    }

    console.log('[M.o.M] ✅ Test trade passed — triple-sweep verified');
    */

    // ── Dynamic Startup Banner (DB-driven) ─────────────────────────────────
    const evalCount   = propAccounts.filter(a => a.phase === 'EVAL').length;
    const fundedCount = propAccounts.filter(a => a.phase === 'FUNDED').length;
    let bufferTag = '';
    if (activePlaybook === 'PROP_FIRM') {
        if (propAccounts.length === 0) {
            bufferTag = 'No Active Accounts — Entries BLOCKED 🚫';
        } else if (propMinBuffer >= 1_500) {
            bufferTag = `Buffer: $${propMinBuffer.toFixed(0)} → ${Math.floor(propMinBuffer / 1_500)} ES`;
        } else {
            bufferTag = `Buffer: $${propMinBuffer.toFixed(0)} → ${Math.floor(propMinBuffer / 150)} MES (auto-scaled)`;
        }
    }
    console.log('\n==========================================');
    console.log('  M.o.M — Institutional Quant Engine v5.1');
    console.log(`  ${tradingMode} | Playbook: ${activePlaybook}`);
    if (activePlaybook === 'PROP_FIRM') {
        console.log(`  Accounts: ${evalCount} EVAL | ${fundedCount} FUNDED`);
        console.log(`  ${bufferTag}`);
    }

    // Register the state-change callback BEFORE initialize() so boot-halt fires it too
    haltManager.onStateChange(async (isHalted, haltType) => {
        if (momWorker) momWorker.postMessage({ type: 'HALT_STATE', payload: isHalted });
        // Push halt/resume notification to dashboard
        if (isHalted) {
            void db.pushNotification('ENGINE_HALTED', `🛑 Engine halted — ${haltType}`);
        } else {
            void db.pushNotification('ENGINE_RESUMED', '🟢 Engine resumed');
        }
        // If an EMERGENCY_CLOSE manual halt is triggered from an external script
        if (isHalted && haltType === 'EMERGENCY_CLOSE') {
            console.log(`\n🚨 [M.o.M] EMERGENCY CLOSE DETECTED via HALT MANAGER. Flattening all positions...`);
            await broker.cancelAllWorkingOrders();
            await executionEngine.flattenPosition(tradeSymbol);
            if (momWorker) momWorker.postMessage({ type: 'position_closed', reason: 'EMERGENCY_CLOSE' });
            await reconcileLedgerOnClose('EMERGENCY_CLOSE');
        }
    });

    // Initialize halt manager — callback is now registered so boot-halt will fire it
    await haltManager.initialize();

    // If engine booted in halt state, emit a dedicated boot notification
    if (haltManager.isHalted()) {
        void db.pushNotification('ENGINE_HALTED', `🛑 Engine booted in HALT state — awaiting manual reset`);
    }

    console.log(`  Phase: ${botState.currentPhase} | Day ${botState.activeTradingDays} | PnL: $${botState.runningPnl.toFixed(2)}`);
    console.log(`  Buying Power: $${ledger.getAvailableBuyingPower().toFixed(0)}`);
    console.log('==========================================');
    // 4. Start warm up sequence
    console.log('\n[M.o.M] 🔄 Starting Warm Up...');
    console.log('[M.o.M] 📡 Requesting Hydration (from 6 PM ET session open)...');
    oracle.postMessage({ type: 'TRIGGER_HYDRATION' });

    await new Promise<void>((resolve) => {
        const handler = (msg: any) => {
            if (msg.type === 'HYDRATION_COMPLETE') {
                oracle.off('message', handler);
                const vix = msg.vixLevel ?? 0;
                const vixTag = vix < 15 ? '😌 Calm — low vol, complacency'
                             : vix < 25 ? '📊 Normal — standard volatility'
                             : vix < 30 ? '⚠️  Elevated — rising fear, wider swings'
                             :            '🔴 Extreme Fear — hedging frenzy, expect chaos';
                console.log(`[M.o.M] ✅ Hydration Complete — ${msg.cmeCount} CME candles | VIX: ${vix.toFixed(2)} (${vixTag})`);
                resolve();
            }
        };
        oracle.on('message', handler);
    });

    console.log('[M.o.M] ✅ Warm Up Complete — all experts have minimum 20 candles');

    // 5. Flip the warmup gate — allow real trades
    console.log('\n==========================================');
    momWorker.postMessage({ type: 'HUNTING_ACTIVE' });
    assistantWorker.postMessage({ type: 'HUNTING_ACTIVE' });

    console.log('  🎯 ALL SYSTEMS PRIMED — HUNTING');
    console.log('==========================================\n');
}

// ─── MoMEngine handler ───────────────────────────────────────────────────────
function wireMomHandler(): void {
    momWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
        switch (msg.type) {
            case 'ready': break;
            case 'trade_command':
                void handleTradeCommand(msg.payload as Record<string, unknown>, 'MoMEngine');
                break;
            case 'trade_closed': break;
            case 'position_closed':
                momWorker.postMessage({ type: 'position_closed', reason: msg.reason });
                break;
            case 'TELEMETRY': {
                const p = msg.payload as { source: string; regime: string; message: string };
                void db.logTelemetry(p.source, p.regime, p.message);
                break;
            }
            case 'TELEMETRY_TRADE_OPEN': {
                const p = msg.payload as { source: string; regime: string; message: string; tradeId: string };
                void db.logTradeEntry(p.source, p.regime, p.message, p.tradeId);
                break;
            }
            case 'TELEMETRY_TRADE_UPDATE': {
                const p = msg.payload as { tradeId: string; event: string };
                void db.appendTradeEvent(p.tradeId, p.event);
                break;
            }
            default: break;
        }
    });
}

// ─── AssistantWorker handler ─────────────────────────────────────────────────
function wireAssistantHandler(): void {
    assistantWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
        switch (msg.type) {
            case 'ready': break;
            case 'assistant_response': break;
            case 'WARMUP_COMPLETE': break;
            case 'overwatch_status': break;

            case 'trade_command':
                void handleTradeCommand(msg.payload as Record<string, unknown>, 'AssistantWorker');
                break;


            case 'overwatch_alert':
                console.log('[M.o.M] ⚠️  Overwatch:', msg.payload);
                break;

            case 'VERIFY_FLAT': {
                const symbol = msg.symbol as string;
                const from   = msg.from   as string;
                checkIsFlat(symbol)
                    .then(isFlat => assistantWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat, symbol, from }))
                    .catch(() => assistantWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat: false, symbol, from }));
                break;
            }
            default: break;
        }
    });
}

// ─── Oracle handler ──────────────────────────────────────────────────────────
function wireOracleHandler(): void {
    oracle.on('message', (msg: { type: string; [key: string]: unknown }) => {
        switch (msg.type) {
            case 'ready': break;
            case 'feed_heartbeat': break;
            case 'feed_status': break;
            case 'tick': break;
            case 'HYDRATION': break;
            case 'HYDRATION_COMPLETE': break;

            case 'defcon_change':
                console.log(`[M.o.M] 🚨 DEFCON → ${msg.level} | ${msg.reason}`);
                void db.pushNotification('DEFCON_CHANGE', `⚠️ DEFCON ${msg.level} — ${msg.reason}`);
                break;

            case 'VERIFY_FLAT': {
                const symbol = msg.symbol as string;
                const from   = msg.from   as string;
                checkIsFlat(symbol)
                    .then(isFlat => oracle.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat, symbol, from }))
                    .catch(() => oracle.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat: false, symbol, from }));
                break;
            }

            case 'system_reset':
                // Clear orphaned position monitors from prior trade cycles
                if (positionMonitor) {
                    clearInterval(positionMonitor);
                    positionMonitor = null;
                }
                if (testTradeResolve) {
                    testTradeResolve();
                    testTradeResolve = null;
                }
                break;

            default: break;
        }
    });
}

// ─── Graceful Shutdown ───────────────────────────────────────────────────────
function shutdown(): void {
    console.log('[M.o.M] Shutting down...');
    ledger.stopReconciliation();
    momWorker      ?.postMessage({ type: 'shutdown' });
    assistantWorker?.postMessage({ type: 'shutdown' });
    oracle         ?.postMessage({ type: 'shutdown' });
    setTimeout(async () => {
        await db.disconnect().catch(() => {});
        process.exit(0);
    }, 2000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ─── Entry Point ─────────────────────────────────────────────────────────────
boot().catch((err: Error) => {
    console.error(`[M.o.M] ❌ BOOT FAILED: ${err.message}`);
    process.exit(1);
});
