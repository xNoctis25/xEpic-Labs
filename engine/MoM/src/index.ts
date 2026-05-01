/**
 * index.ts — Master Thread (Core 4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  Core 1 │ MomWorker       → SMC signal evaluation + trade execution
 *  Core 2 │ AssistantWorker → ORB Hunter + Tactical Overwatch + Triple-Sweep P2
 *  Core 3 │ OracleWorker    → Databento dual-feed + Macro Radar + WSS
 *  Core 4 │ THIS FILE       → Boot, broker I/O, ExecutionEngine, lifecycle
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as dotenv from 'dotenv';
import * as path   from 'path';
import { Worker, MessageChannel } from 'worker_threads';

import { TradovateBroker }                  from './brokers/TradovateBroker';
import { NeonDatabase }                     from './services/NeonDatabase';
import { ExecutionEngine }                  from './core/ExecutionEngine';
import { SessionLedger }                    from './services/SessionLedger';
import { PositionSizer, ES_DAY_MARGIN, MES_DAY_MARGIN } from './core/PositionSizer';
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

// ─── Trade command dispatcher ────────────────────────────────────────────────
async function handleTradeCommand(
    payload: Record<string, unknown>,
    source:  'MomWorker' | 'AssistantWorker',
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

            console.log(`[M.o.M] 🔥 ENTER ${side} ${symbol} @ ${price} | Src: ${src} | Conf: ${conf}/8`);

            const sizing = PositionSizer.calculate(
                ledger.getAvailableBuyingPower(), 20, config.INDICES,
            );
            if (!sizing) {
                console.warn('[M.o.M] ❌ Trade BLOCKED — insufficient buying power.');
                return;
            }

            const marginPerContract = sizing.symbolRoot === 'ES' ? ES_DAY_MARGIN : MES_DAY_MARGIN;
            ledger.reserveMargin(sizing.qty * marginPerContract);

            await executionEngine.executeBracket(symbol, price, side, sizing.qty);
            if (positionMonitor) clearInterval(positionMonitor);
            positionMonitor = setInterval(async () => {
                try {
                    const net = await broker.getNetPositionQty(symbol);
                    if (net === 0) {
                        clearInterval(positionMonitor!); positionMonitor = null;
                        console.log(`[M.o.M] ✅ Position FLAT — bracket filled.`);
                        momWorker.postMessage({ type: 'position_closed', reason: 'NATURAL_BRACKET_FILL' });
                    }
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

    console.log('==========================================');
    console.log('  M.o.M — Institutional Quant Engine v5.1');
    console.log(`  ${tradingMode} | ${config.INDICES} | Risk: ${config.RISK}%`);
    console.log(`  Playbook: ${playbookLabel}`);
    console.log(`  Phase: ${botState.currentPhase} | Day ${botState.activeTradingDays} | PnL: $${botState.runningPnl.toFixed(2)}`);
    console.log('==========================================\n');

    const connected = await broker.connect();
    if (!connected) throw new Error('Broker auth failed');
    console.log('[M.o.M] ✅ Broker authenticated');

    await ledger.initialize(broker);
    console.log(`[M.o.M] ✅ Ledger synced — $${ledger.getAvailableBuyingPower().toFixed(0)} buying power`);

    // 2. Spawn Workers + Wire IPC Mesh
    momWorker       = new Worker(workerPath('MomWorker'), workerOpts);
    assistantWorker = new Worker(workerPath('AssistantWorker'), workerOpts);
    oracleWorker    = new Worker(workerPath('OracleWorker'), workerOpts);

    momWorker      .on('error', onWorkerError('MomWorker'))      .on('exit', onWorkerExit('MomWorker'));
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

    // 4. Zero-Gap Hydration: wait for Databento historical to catch up
    //    Databento has ~15 min processing delay. We wait 16 min from feed start,
    //    then fetch historical ending at feed start time. Live candles cover
    //    from feed start to now. Result = ZERO GAP.
    const DATABENTO_DELAY_MS = 16 * 60_000; // 15 min delay + 1 min buffer
    oracleWorker.postMessage({ type: 'GET_FEED_START_TIME' });

    const feedStartTime = await new Promise<number>((resolve) => {
        const handler = (msg: any) => {
            if (msg.type === 'FEED_START_TIME') {
                oracleWorker.off('message', handler);
                resolve(msg.feedStartTime as number);
            }
        };
        oracleWorker.on('message', handler);
    });

    const elapsed = Date.now() - feedStartTime;
    const waitMs  = Math.max(0, DATABENTO_DELAY_MS - elapsed);

    if (waitMs > 0) {
        const waitMin = (waitMs / 60_000).toFixed(1);
        console.log(`[M.o.M] ⏳ Building live candles... hydration in ${waitMin}min (Databento sync)`);
        await new Promise(r => setTimeout(r, waitMs));
    }

    console.log('[M.o.M] 💧 Hydrating historical data...');
    oracleWorker.postMessage({ type: 'TRIGGER_HYDRATION' });

    await new Promise<void>((resolve) => {
        const handler = (msg: any) => {
            if (msg.type === 'HYDRATION_COMPLETE') {
                oracleWorker.off('message', handler);
                console.log(`[M.o.M] ✅ Hydrated: ${msg.cmeCount} CME + ${msg.cfeCount} CFE candles | VIX: ${(msg.vixLevel ?? 0).toFixed(2)}`);
                resolve();
            }
        };
        oracleWorker.on('message', handler);
    });

    console.log('\n==========================================');
    console.log('  🎯 ALL SYSTEMS PRIMED — HUNTING');
    console.log('==========================================\n');
}

// ─── MomWorker handler ───────────────────────────────────────────────────────
function wireMomHandler(): void {
    momWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
        switch (msg.type) {
            case 'ready': break;
            case 'trade_command':
                void handleTradeCommand(msg.payload as Record<string, unknown>, 'MomWorker');
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

            case 'orb_alert':
                console.log('[M.o.M] 🔭 ORB Signal:', msg.payload);
                break;
            case 'overwatch_alert':
                console.log('[M.o.M] ⚠️  Overwatch:', msg.payload);
                break;

            case 'TELEMETRY': {
                const p = msg.payload as { source: string; regime: string; message: string };
                void db.logTelemetry(p.source, p.regime, p.message);
                break;
            }

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
            case 'FEED_START_TIME': break;  // Handled by boot await

            case 'defcon_change':
                console.log(`[M.o.M] 🚨 DEFCON → ${msg.level} | ${msg.reason}`);
                break;

            case 'TELEMETRY': {
                const p = msg.payload as { source: string; regime: string; message: string };
                void db.logTelemetry(p.source, p.regime, p.message);
                break;
            }

            case 'VERIFY_FLAT': {
                const symbol = msg.symbol as string;
                const from   = msg.from   as string;
                checkIsFlat(symbol)
                    .then(isFlat => oracleWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat, symbol, from }))
                    .catch(() => oracleWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat: false, symbol, from }));
                break;
            }

            case 'system_reset':
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
    momWorker      ?.postMessage({ type: 'shutdown' });
    assistantWorker?.postMessage({ type: 'shutdown' });
    oracleWorker   ?.postMessage({ type: 'shutdown' });
    setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ─── Entry Point ─────────────────────────────────────────────────────────────
boot().catch((err: Error) => {
    console.error(`[M.o.M] ❌ BOOT FAILED: ${err.message}`);
    process.exit(1);
});
