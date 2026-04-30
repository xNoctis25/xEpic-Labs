/**
 * index.ts — Master Thread (Core 4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  4-Core Distributed Architecture
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Core 1 │ MomWorker       → SMC + ORB signal evaluation + trade execution
 *  Core 2 │ AssistantWorker → ORB Hunter + Tactical Overwatch + Triple-Sweep P2
 *  Core 3 │ OracleWorker    → Databento dual-feed + Macro Radar + WSS Receptionist
 *  Core 4 │ THIS FILE       → Boot, broker I/O, ExecutionEngine, lifecycle
 *
 *  IPC Mesh (Zero-Latency Direct Ports via MessageChannel):
 *    OracleWorker ──(oracleMom)──▶ MomWorker
 *    OracleWorker ──(oracleAssist)▶ AssistantWorker
 *    MomWorker    ──(momAssist)──▶  AssistantWorker
 *
 *  All trade_command messages travel parentPort → Core 4 → Broker.
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

// ─────────────────────────────────────────────────────────────────────────────
// Banner
// ─────────────────────────────────────────────────────────────────────────────
console.log('==========================================');
console.log('  M.o.M (Master of Masters) Quant Engine  ');
console.log('  Version 5.0 - 4-Core Worker Architecture');
console.log(`  Risk: ${config.RISK}%`);
console.log('==========================================\n');

// ─────────────────────────────────────────────────────────────────────────────
// Global Services (live in Main thread only — no cross-thread sharing)
// ─────────────────────────────────────────────────────────────────────────────
const broker          = new TradovateBroker();
const db              = new NeonDatabase();
const executionEngine = new ExecutionEngine(broker, db);
const ledger          = new SessionLedger();

// ─────────────────────────────────────────────────────────────────────────────
// Worker handles (declared at module scope for shutdown access)
// ─────────────────────────────────────────────────────────────────────────────
let momWorker:       Worker;
let assistantWorker: Worker;
let oracleWorker:    Worker;

// ─────────────────────────────────────────────────────────────────────────────
// Helper — resolve compiled worker path
// ─────────────────────────────────────────────────────────────────────────────
const isTsNode = __filename.endsWith('.ts');

function workerPath(name: string): string {
    const ext = isTsNode ? '.ts' : '.js';
    return path.join(__dirname, 'core', `${name}${ext}`);
}

const workerOpts = isTsNode ? { execArgv: ['-r', 'ts-node/register'] } : {};

// ─────────────────────────────────────────────────────────────────────────────
// Worker Error / Exit Handlers
// ─────────────────────────────────────────────────────────────────────────────
function onWorkerError(name: string) {
    return (err: Error) => console.error(`[Core 4] 🔴 ${name} crashed:`, err);
}
function onWorkerExit(name: string) {
    return (code: number) => {
        if (code !== 0) console.error(`[Core 4] 🔴 ${name} exited with code ${code}`);
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY_FLAT — queries broker for real net position + working stops
// ─────────────────────────────────────────────────────────────────────────────
async function checkIsFlat(symbol: string): Promise<boolean> {
    const [netPos, stopCount] = await Promise.all([
        broker.getNetPositionQty(symbol),
        broker.getWorkingStopOrders(symbol),
    ]);
    return netPos === 0 && stopCount === 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// trade_command dispatcher — wires Core 1 actions to ExecutionEngine + Broker
// ─────────────────────────────────────────────────────────────────────────────
async function handleTradeCommand(
    payload: Record<string, unknown>,
    source:  'MomWorker' | 'AssistantWorker',
): Promise<void> {
    const action = payload.action as string;

    switch (action) {

        case 'ENTER': {
            const symbol    = payload.symbol    as string;
            const price     = payload.price     as number;
            const rawDir    = payload.direction as string;
            const side: 'BUY' | 'SELL' = (rawDir === 'LONG' || rawDir === 'BUY') ? 'BUY' : 'SELL';

            console.log(`[Core 4] 🔥 ENTER ${side} ${symbol} @ ${price} (src: ${source})`);

            const sizing = PositionSizer.calculate(
                ledger.getAvailableBuyingPower(),
                20,                 // SL_POINTS
                config.INDICES,
            );

            if (!sizing) {
                console.warn('[Core 4] PositionSizer returned null — trade BLOCKED (insufficient buying power).');
                return;
            }

            const marginPerContract = sizing.symbolRoot === 'ES' ? ES_DAY_MARGIN : MES_DAY_MARGIN;
            ledger.reserveMargin(sizing.qty * marginPerContract);

            await executionEngine.executeBracket(symbol, price, side, sizing.qty);
            break;
        }

        case 'FLATTEN_ALL': {
            const symbol = payload.symbol as string | undefined;
            console.log(`[Core 4] 🧹 FLATTEN_ALL ${symbol ?? '(all)'} — triggered by ${source}`);
            if (symbol) {
                await executionEngine.flattenPosition(symbol);
            } else {
                await broker.cancelAllWorkingOrders();
            }
            break;
        }

        case 'CANCEL_ALL_ORDERS': {
            console.log(`[Core 4] ❌ CANCEL_ALL_ORDERS — ${payload.symbol ?? 'all'}`);
            await broker.cancelAllWorkingOrders();
            break;
        }

        case 'MOVE_STOP_TO_BE':
        case 'TIGHTEN_STOP': {
            const symbol    = payload.symbol    as string;
            const stopPrice = payload.stopPrice as number;
            const rawDir    = (payload.direction as string | undefined) ?? 'LONG';
            // exitAction is opposite of our position direction
            const exitAction: 'Buy' | 'Sell' = (rawDir === 'LONG' || rawDir === 'BUY') ? 'Sell' : 'Buy';

            console.log(`[Core 4] 🛑 ${action} ${symbol} → stop @ ${stopPrice}`);
            await broker.modifyStopWithVerification(symbol, exitAction, 1, stopPrice);
            break;
        }

        default:
            console.warn(`[Core 4] Unknown trade_command action: ${action}`);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// BOOT — sequential service init → spawn workers → wire IPC mesh
// ─────────────────────────────────────────────────────────────────────────────
async function boot(): Promise<void> {
    console.log('[Core 4] 🔍 Initializing core services…');

    // 1. Neon Postgres
    await db.initialize();
    console.log('[Core 4] ✅ Neon Postgres connected.');

    // 2. Tradovate Broker OAuth
    const connected = await broker.connect();
    if (!connected) throw new Error('TradovateBroker.connect() returned false.');
    console.log('[Core 4] ✅ TradovateBroker authenticated.');

    // 3. Session Ledger balance sync
    await ledger.initialize(broker);
    console.log(`[Core 4] ✅ SessionLedger synced. Buying Power: $${ledger.getAvailableBuyingPower().toFixed(2)}`);

    // ── Spawn Workers ─────────────────────────────────────────────────────────
    console.log('[Core 4] 🚀 Spawning 3 worker cores…');
    momWorker       = new Worker(workerPath('MomWorker'), workerOpts);
    assistantWorker = new Worker(workerPath('AssistantWorker'), workerOpts);
    oracleWorker    = new Worker(workerPath('OracleWorker'), workerOpts);

    // ── Wire Error / Exit Handlers ────────────────────────────────────────────
    momWorker      .on('error', onWorkerError('MomWorker'))      .on('exit', onWorkerExit('MomWorker'));
    assistantWorker.on('error', onWorkerError('AssistantWorker')).on('exit', onWorkerExit('AssistantWorker'));
    oracleWorker   .on('error', onWorkerError('OracleWorker'))   .on('exit', onWorkerExit('OracleWorker'));


    // ── Build Zero-Latency IPC Mesh via MessageChannel ────────────────────────
    //   Channel A: OracleWorker ←→ MomWorker       (ticks / emergency)
    //   Channel B: OracleWorker ←→ AssistantWorker (ticks / oracle state)
    //   Channel C: MomWorker    ←→ AssistantWorker (ORB / IN_TRADE / sweep)
    const channelOracleMom    = new MessageChannel();   // Channel A
    const channelOracleAssist = new MessageChannel();   // Channel B
    const channelMomAssist    = new MessageChannel();   // Channel C

    // MomWorker — port1 from A (reads Oracle), port1 from C (r/w Assistant)
    momWorker.postMessage(
        { type: 'init', oraclePort: channelOracleMom.port1, assistPort: channelMomAssist.port1 },
        [channelOracleMom.port1, channelMomAssist.port1],
    );

    // AssistantWorker — port2 from C (r/w Mom), port1 from B (r/w Oracle)
    assistantWorker.postMessage(
        { type: 'init', momPort: channelMomAssist.port2, oraclePort: channelOracleAssist.port1 },
        [channelMomAssist.port2, channelOracleAssist.port1],
    );

    // OracleWorker — port2 from A (r/w Mom), port2 from B (r/w Assistant)
    oracleWorker.postMessage(
        { type: 'init', momPort: channelOracleMom.port2, assistPort: channelOracleAssist.port2 },
        [channelOracleMom.port2, channelOracleAssist.port2],
    );


    // ── Wire Message Handlers ─────────────────────────────────────────────────
    wireMomHandler();
    wireAssistantHandler();
    wireOracleHandler();

    console.log('[Core 4] ✅ All systems live — 4-core mesh active.\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// MomWorker message handler
// ─────────────────────────────────────────────────────────────────────────────
function wireMomHandler(): void {
    momWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
        switch (msg.type) {

            case 'ready':
                console.log('[Core 4] ✅ MomWorker (Core 1) ready.');
                break;

            case 'trade_command':
                void handleTradeCommand(msg.payload as Record<string, unknown>, 'MomWorker');
                break;

            case 'trade_closed':
                console.log('[Core 4] 📊 Trade closed:', msg.payload);
                break;

            case 'position_closed':
                momWorker.postMessage({ type: 'position_closed', reason: msg.reason });
                break;

            /**
             * TELEMETRY — structured event from MomWorker.
             * Fire-and-forget insert into mom_telemetry_logs.
             */
            case 'TELEMETRY': {
                const p = msg.payload as { source: string; regime: string; message: string };
                void db.logTelemetry(p.source, p.regime, p.message);
                break;
            }

            default:
                console.warn('[Core 4] MomWorker unknown msg:', msg.type);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// AssistantWorker message handler
// ─────────────────────────────────────────────────────────────────────────────
function wireAssistantHandler(): void {
    assistantWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
        switch (msg.type) {

            case 'ready':
                console.log('[Core 4] ✅ AssistantWorker (Core 2) ready.');
                break;

            case 'assistant_response':
                // TODO Phase 6: push to Nova dashboard via WebSocket
                console.log('[Core 4] 🤖 Nova response:', msg.payload);
                break;

            case 'trade_command':
                // IMMINENT_REVERSION tighten-stop or FLATTEN_ALL relayed from AssistantWorker
                void handleTradeCommand(msg.payload as Record<string, unknown>, 'AssistantWorker');
                break;

            case 'orb_alert':       console.log('[Core 4] 🔭 ORB Alert:', msg.payload); break;
            case 'overwatch_alert': console.log('[Core 4] ⚠️  Overwatch Alert:', msg.payload); break;
            case 'overwatch_status': /* silent */ break;

            /**
             * TELEMETRY — structured event from AssistantWorker.
             * Fire-and-forget insert into mom_telemetry_logs.
             */
            case 'TELEMETRY': {
                const p = msg.payload as { source: string; regime: string; message: string };
                void db.logTelemetry(p.source, p.regime, p.message);
                break;
            }

            /**
             * VERIFY_FLAT (Phase 2) — AssistantWorker requests real broker flat check.
             */
            case 'VERIFY_FLAT': {
                const symbol = msg.symbol as string;
                const from   = msg.from   as string;
                console.log(`[Core 4] 🧹 VERIFY_FLAT Phase 2 for ${symbol}`);
                checkIsFlat(symbol)
                    .then(isFlat => assistantWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat, symbol, from }))
                    .catch(err  => {
                        console.error('[Core 4] VERIFY_FLAT Phase 2 error:', err.message);
                        assistantWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat: false, symbol, from });
                    });
                break;
            }

            default:
                console.warn('[Core 4] AssistantWorker unknown msg:', msg.type);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// OracleWorker message handler
// ─────────────────────────────────────────────────────────────────────────────
function wireOracleHandler(): void {
    oracleWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
        switch (msg.type) {

            case 'ready':
                console.log('[Core 4] ✅ OracleWorker (Core 3) ready — dual feed starting.');
                break;

            case 'feed_heartbeat': break;  // silent

            case 'feed_status':
                console.log(`[Core 4] 📡 Feed [${msg.label}]: ${msg.status}`);
                break;

            case 'defcon_change':
                console.log(`[Core 4] 🚨 DefconLevel → ${msg.level} | ${msg.reason}`);
                break;

            /**
             * TELEMETRY — structured event from OracleWorker.
             * Fire-and-forget insert into mom_telemetry_logs.
             */
            case 'TELEMETRY': {
                const p = msg.payload as { source: string; regime: string; message: string };
                void db.logTelemetry(p.source, p.regime, p.message);
                break;
            }

            /**
             * VERIFY_FLAT (Phase 3) — OracleWorker requests the FINAL broker flat check.
             */
            case 'VERIFY_FLAT': {
                const symbol = msg.symbol as string;
                const from   = msg.from   as string;
                console.log(`[Core 4] 🧹 VERIFY_FLAT Phase 3 for ${symbol}`);
                checkIsFlat(symbol)
                    .then(isFlat => oracleWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat, symbol, from }))
                    .catch(err  => {
                        console.error('[Core 4] VERIFY_FLAT Phase 3 error:', err.message);
                        oracleWorker.postMessage({ type: 'VERIFY_FLAT_RESULT', isFlat: false, symbol, from });
                    });
                break;
            }

            case 'system_reset':
                console.log(`[Core 4] 🔭 SYSTEM_RESET confirmed — ${msg.symbol} cycle complete.`);
                break;

            case 'tick':
                break; // Silent pass-through (forwarded to dashboard later)

            case 'HYDRATION':
                break; // Handled locally by workers, ignored by Main

            default:
                console.warn('[Core 4] OracleWorker unknown msg:', msg.type);
        }
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────
function shutdown(): void {
    console.log('\n[Core 4] Shutdown signal — stopping all workers…');
    momWorker      ?.postMessage({ type: 'shutdown' });
    assistantWorker?.postMessage({ type: 'shutdown' });
    oracleWorker   ?.postMessage({ type: 'shutdown' });
    setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ─────────────────────────────────────────────────────────────────────────────
// Entry Point
// ─────────────────────────────────────────────────────────────────────────────
boot().catch((err: Error) => {
    console.error('[Core 4] 🔴 BOOT FAILED:', err.message);
    process.exit(1);
});
