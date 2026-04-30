/**
 * index.ts — Master Thread (Core 4)
 * ─────────────────────────────────────────────────────────────────────────────
 *  4-Core Distributed Architecture
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  Core 1 │ MomWorker      → Signal evaluation + trade execution
 *  Core 2 │ AssistantWorker → Nova AI assistant + analytics
 *  Core 3 │ OracleWorker   → Databento TCP market data feed
 *  Core 4 │ THIS FILE      → Master thread: broker I/O, WebSocket, lifecycle
 *
 *  IPC Mesh (Zero-Latency Direct Ports via MessageChannel):
 *
 *    OracleWorker ──(oracleMom)──▶ MomWorker
 *    OracleWorker ──(oracleAssist)▶ AssistantWorker
 *    MomWorker    ──(momAssist)──▶ AssistantWorker
 *
 *    All trade commands and assistant responses travel back through
 *    parentPort → Main (Core 4) for broker dispatch / WebSocket delivery.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as dotenv from 'dotenv';
import * as path   from 'path';
import { Worker, MessageChannel, MessagePort } from 'worker_threads';

import { TradovateBroker } from './brokers/TradovateBroker';
import { config }          from './config/env';

dotenv.config();

// ─────────────────────────────────────────────────────────────────────────────
// Banner
// ─────────────────────────────────────────────────────────────────────────────
console.log('==========================================');
console.log('  M.o.M (Master of Masters) Quant Engine  ');
console.log('  Version 3.0 - 4-Core Worker Architecture');
console.log(`  Risk: ${config.RISK}%`);
console.log('==========================================\n');

// ─────────────────────────────────────────────────────────────────────────────
// Helper — resolve compiled worker path
// ─────────────────────────────────────────────────────────────────────────────
function workerPath(name: string): string {
    // ts-node: source path;  compiled: dist/ path.
    // We use __dirname which points to src/  (ts-node) or dist/  (tsc).
    return path.join(__dirname, 'core', `${name}.js`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Spawn Workers
// ─────────────────────────────────────────────────────────────────────────────
const momWorker       = new Worker(workerPath('MomWorker'));
const assistantWorker = new Worker(workerPath('AssistantWorker'));
const oracleWorker    = new Worker(workerPath('OracleWorker'));

// ─────────────────────────────────────────────────────────────────────────────
// Build Zero-Latency IPC Mesh via MessageChannel
// ─────────────────────────────────────────────────────────────────────────────
//
// Three direct channels — Main is NOT in the hot path:
//   Channel A: OracleWorker ←→ MomWorker      (candles / ticks)
//   Channel B: OracleWorker ←→ AssistantWorker (market context)
//   Channel C: MomWorker    ←→ AssistantWorker (engine state)
//
const channelOracleMom     = new MessageChannel();   // Channel A
const channelOracleAssist  = new MessageChannel();   // Channel B
const channelMomAssist     = new MessageChannel();   // Channel C

// ─────────────────────────────────────────────────────────────────────────────
// Wire & Init Workers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * MomWorker — receives:
 *   • port1 from Channel A (reads from Oracle)
 *   • port1 from Channel C (writes to Assistant)
 */
momWorker.postMessage(
    {
        type:        'init',
        oraclePort:  channelOracleMom.port1,    // Oracle → Mom
        assistPort:  channelMomAssist.port1,     // Mom   → Assistant
    },
    [channelOracleMom.port1, channelMomAssist.port1]   // transfer ownership
);

/**
 * AssistantWorker — receives:
 *   • port2 from Channel C (reads from Mom)
 *   • port1 from Channel B (reads from Oracle)
 */
assistantWorker.postMessage(
    {
        type:        'init',
        momPort:     channelMomAssist.port2,     // Mom    → Assistant
        oraclePort:  channelOracleAssist.port1,  // Oracle → Assistant
    },
    [channelMomAssist.port2, channelOracleAssist.port1]
);

/**
 * OracleWorker — receives:
 *   • port2 from Channel A (writes to Mom)
 *   • port2 from Channel B (writes to Assistant)
 */
oracleWorker.postMessage(
    {
        type:        'init',
        momPort:     channelOracleMom.port2,     // Oracle → Mom
        assistPort:  channelOracleAssist.port2,  // Oracle → Assistant
    },
    [channelOracleMom.port2, channelOracleAssist.port2]
);

// ─────────────────────────────────────────────────────────────────────────────
// Main Thread Message Handlers
// ─────────────────────────────────────────────────────────────────────────────

momWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {
        case 'ready':
            console.log('[Core 4] ✅ MomWorker (Core 1) ready.');
            break;

        case 'trade_command': {
            // TODO Phase 2: forward to TradovateBroker
            console.log('[Core 4] 📡 Trade command received from MomWorker:', msg.payload);
            break;
        }

        default:
            console.warn('[Core 4] MomWorker unknown msg:', msg.type);
    }
});

assistantWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {
        case 'ready':
            console.log('[Core 4] ✅ AssistantWorker (Core 2) ready.');
            break;

        case 'assistant_response': {
            // TODO Phase 2: push to Nova dashboard via WebSocket
            console.log('[Core 4] 🤖 Nova response:', msg.payload);
            break;
        }

        default:
            console.warn('[Core 4] AssistantWorker unknown msg:', msg.type);
    }
});

oracleWorker.on('message', (msg: { type: string; [key: string]: unknown }) => {
    switch (msg.type) {
        case 'ready':
            console.log('[Core 4] ✅ OracleWorker (Core 3) ready — feed starting.');
            break;

        case 'feed_heartbeat':
            // Silently absorb heartbeats; log only if debugging needed
            break;

        default:
            console.warn('[Core 4] OracleWorker unknown msg:', msg.type);
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// Error & Exit Handlers
// ─────────────────────────────────────────────────────────────────────────────

function onWorkerError(name: string) {
    return (err: Error) => console.error(`[Core 4] 🔴 ${name} crashed:`, err);
}

function onWorkerExit(name: string) {
    return (code: number) => {
        if (code !== 0) console.error(`[Core 4] 🔴 ${name} exited with code ${code}`);
    };
}

momWorker      .on('error', onWorkerError('MomWorker'))      .on('exit', onWorkerExit('MomWorker'));
assistantWorker.on('error', onWorkerError('AssistantWorker')).on('exit', onWorkerExit('AssistantWorker'));
oracleWorker   .on('error', onWorkerError('OracleWorker'))   .on('exit', onWorkerExit('OracleWorker'));

// ─────────────────────────────────────────────────────────────────────────────
// Graceful Shutdown
// ─────────────────────────────────────────────────────────────────────────────

function shutdown(): void {
    console.log('\n[Core 4] Shutdown signal received — stopping all workers…');
    momWorker      .postMessage({ type: 'shutdown' });
    assistantWorker.postMessage({ type: 'shutdown' });
    oracleWorker   .postMessage({ type: 'shutdown' });
    setTimeout(() => process.exit(0), 2000);
}

process.on('SIGINT',  shutdown);
process.on('SIGTERM', shutdown);

// ─────────────────────────────────────────────────────────────────────────────
// TODO Phase 2: initialize TradovateBroker in THIS thread only
// ─────────────────────────────────────────────────────────────────────────────
// const broker = new TradovateBroker();
// broker.connect().then(() => { ... });

console.log('[Core 4] 🚀 Master thread live — spawning 3 worker cores…');
