/**
 * index.ts — Master Thread (Core 4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Core 1 │ MoMEngine       → SMC signal evaluation + trade execution
 *  Core 2 │ AssistantWorker → Tactical Overwatch + Triple-Sweep P2
 *  Core 3 │ OracleWorker    → Databento dual-feed + Macro Radar + WSS
 *  Core 4 │ THIS FILE       → Boot, broker I/O, ExecutionEngine, lifecycle
 * ─────────────────────────────────────────────────────────────────────────────
 */

// Suppress Node.js deprecation warnings (pg SSL, etc.)
process.env.NODE_NO_WARNINGS = '1';

import * as dotenv from 'dotenv';
import * as path   from 'path';
import { Worker, MessageChannel } from 'worker_threads';

import { TradovateBroker }                  from './brokers/TradovateBroker';
import { NeonDatabase }                     from './services/NeonDatabase';
import { ExecutionEngine }                  from './core/ExecutionEngine';
import { SessionLedger }                    from './services/SessionLedger';
import { PositionSizer, ES_DAY_MARGIN, MES_DAY_MARGIN } from './core/PositionSizer';
import { RiskEngine }                    from './core/RiskEngine';
import { EvaluationEngine }              from './core/EvaluationEngine';
import { config }                           from './config/env';

dotenv.config();

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
const evalEngine      = new EvaluationEngine(db);
let positionMonitor: NodeJS.Timeout | null = null;

// ─── Worker handles ──────────────────────────────────────────────────────────
let momWorker:       Worker;
let assistantWorker: Worker;
let oracleWorker:    Worker;

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
                return;
            }

            const sizing = PositionSizer.calculate(
                ledger.getAvailableBuyingPower(), 20, config.INDICES,
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
            await broker.modifyStopWithVerification(symbol, exitAction, 1, stopPrice);
            break;
        }

        default:
            console.warn(`[M.o.M] Unknown trade action: ${action}`);
    }
}

// ─── BOOT SEQUENCE ───────────────────────────────────────────────────────────
async function boot(): Promise<void> {

    // 1. Core Services
    await db.initialize();
    const botState = await db.getState();

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
    oracleWorker    = new Worker(workerPath('OracleWorker'), workerOpts);

    momWorker      .on('error', onWorkerError('MoMEngine'))      .on('exit', onWorkerExit('MoMEngine'));
    assistantWorker.on('error', onWorkerError('AssistantWorker')).on('exit', onWorkerExit('AssistantWorker'));
    oracleWorker   .on('error', onWorkerError('OracleWorker'))   .on('exit', onWorkerExit('OracleWorker'));

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
    oracleWorker.postMessage(
        { type: 'init', momPort: channelOracleMom.port2, assistPort: channelOracleAssist.port2 },
        [channelOracleMom.port2, channelOracleAssist.port2],
    );

    wireMomHandler();
    wireAssistantHandler();
    wireOracleHandler();

    console.log('[M.o.M] ✅ 4-core mesh online — feeds connecting...');

    // 3. Wait for test trade to complete (60s timeout = HALT on failure)
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

    console.log('\n==========================================');
    console.log('  M.o.M — Institutional Quant Engine v5.1');
    console.log(`  ${tradingMode} | ${config.INDICES} | Risk: ${config.RISK}%`);
    console.log(`  Playbook: ${playbookLabel}`);
    console.log(`  Phase: ${botState.currentPhase} | Day ${botState.activeTradingDays} | PnL: $${botState.runningPnl.toFixed(2)}`);
    console.log(`  Buying Power: $${ledger.getAvailableBuyingPower().toFixed(0)}`);
    console.log('==========================================');
    // 4. Start warm up sequence
    console.log('\n[M.o.M] 🔄 Starting Warm Up...');
    console.log('[M.o.M] 📡 Requesting Hydration (from 6 PM ET session open)...');
    oracleWorker.postMessage({ type: 'TRIGGER_HYDRATION' });

    await new Promise<void>((resolve) => {
        const handler = (msg: any) => {
            if (msg.type === 'HYDRATION_COMPLETE') {
                oracleWorker.off('message', handler);
                const vix = msg.vixLevel ?? 0;
                const vixTag = vix < 15 ? '😌 Calm — low vol, complacency'
                             : vix < 25 ? '📊 Normal — standard volatility'
                             : vix < 30 ? '⚠️  Elevated — rising fear, wider swings'
                             :            '🔴 Extreme Fear — hedging frenzy, expect chaos';
                console.log(`[M.o.M] ✅ Hydration Complete — ${msg.cmeCount} CME + ${msg.cfeCount} CFE candles | VIX: ${vix.toFixed(2)} (${vixTag})`);
                resolve();
            }
        };
        oracleWorker.on('message', handler);
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

// ─── OracleWorker handler ────────────────────────────────────────────────────
function wireOracleHandler(): void {
    oracleWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
        switch (msg.type) {
            case 'ready': break;
            case 'feed_heartbeat': break;
            case 'feed_status': break;
            case 'tick': break;
            case 'HYDRATION': break;
            case 'HYDRATION_COMPLETE': break;

            case 'defcon_change':
                console.log(`[M.o.M] 🚨 DEFCON → ${msg.level} | ${msg.reason}`);
                break;

            case 'VERIFY_FLAT': {
                const symbol = msg.symbol as string;
                const from   = msg.from   as string;
                checkIsFlat(symbol)
                    .then(isFlat => oracleWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat, symbol, from }))
                    .catch(() => oracleWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat: false, symbol, from }));
                break;
            }

            case 'system_reset':
                // Clear orphaned position monitors from prior trade cycles
                if (positionMonitor) {
                    clearInterval(positionMonitor);
                    positionMonitor = null;
                }
                if (msg.reason === 'TEST_TRADE_COMPLETE' && testTradeResolve) {
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
    oracleWorker   ?.postMessage({ type: 'shutdown' });
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
