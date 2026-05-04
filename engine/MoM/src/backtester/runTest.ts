import 'dotenv/config';
import { DataLoader } from './DataLoader';
import { BacktestEngine } from './BacktestEngine';
import { config } from '../config/env';

async function run() {
    const symbol = config.INDICES === 'ES' ? 'ES.c.0' : 'MES.c.0';
    const cap = config.MAX_CONTRACTS > 0 ? `Max ${config.MAX_CONTRACTS} contracts` : `${config.RISK}% risk`;

    console.log("=== M.o.M Backtest Engine ===");
    console.log(`[Preflight] Capital: $${config.BACKTEST_CAPITAL} | Index: ${config.INDICES} | Sizing: ${cap}`);
    console.log(`[Preflight] Symbol: ${symbol}`);
    console.log(`[Preflight] Time Decay: ${config.ENABLE_TIME_DECAY ? `ON (${config.TIME_DECAY_CANDLES} candles)` : 'OFF'}`);
    console.log(`[Preflight] Exhaustion: ${config.ENABLE_EXHAUSTION ? 'ON' : 'OFF'}\n`);

    const startDate = new Date('2026-01-01T00:00:00Z');
    const endDate = new Date('2026-03-31T23:59:59Z');

    const candles = await DataLoader.loadHistoricalData(symbol, startDate, endDate);

    const engine = new BacktestEngine(config.BACKTEST_CAPITAL);
    const report = await engine.runStandardBacktest(candles, symbol);

    // ── Per-Trade Deep Dive ──
    console.log("\n=== TRADE-BY-TRADE ANALYSIS ===\n");
    console.log(
        '#'.padEnd(3) +
        'Dir'.padEnd(6) +
        'Entry'.padEnd(10) +
        'Exit'.padEnd(10) +
        'SL Dist'.padEnd(9) +
        'P&L'.padEnd(12) +
        'R-Mult'.padEnd(9) +
        'Prob'.padEnd(6) +
        'Exit Reason'
    );
    console.log('─'.repeat(100));

    for (let i = 0; i < report.trades.length; i++) {
        const t = report.trades[i];
        const dir = t.isLong ? 'LONG' : 'SHORT';
        const pnlStr = t.pnl >= 0 ? `+$${t.pnl.toFixed(2)}` : `-$${Math.abs(t.pnl).toFixed(2)}`;
        const rStr = t.rMultiple >= 0 ? `+${t.rMultiple.toFixed(2)}R` : `${t.rMultiple.toFixed(2)}R`;

        console.log(
            `${(i + 1).toString().padEnd(3)}` +
            `${dir.padEnd(6)}` +
            `${t.entryPrice.toFixed(2).padEnd(10)}` +
            `${t.exitPrice.toFixed(2).padEnd(10)}` +
            `${t.riskR.toFixed(1).padEnd(9)}` +
            `${pnlStr.padEnd(12)}` +
            `${rStr.padEnd(9)}` +
            `${(t.confidence + '%').padEnd(6)}` +
            `${t.exitReason}`
        );
    }

    // ── Summary Stats ──
    const winners = report.trades.filter(t => t.pnl > 0);
    const losers = report.trades.filter(t => t.pnl <= 0);

    console.log('\n=== EXIT REASON BREAKDOWN ===');
    const reasons = new Map<string, { count: number; totalPnl: number }>();
    for (const t of report.trades) {
        const r = reasons.get(t.exitReason) || { count: 0, totalPnl: 0 };
        r.count++;
        r.totalPnl += t.pnl;
        reasons.set(t.exitReason, r);
    }
    for (const [reason, data] of reasons) {
        console.log(`  ${reason}: ${data.count} trades | P&L: $${data.totalPnl.toFixed(2)}`);
    }

    console.log('\n=== R-MULTIPLE DISTRIBUTION ===');
    const rBuckets = { 'Loss (< 0R)': 0, '0-0.5R': 0, '0.5-1R': 0, '1-2R': 0, '2-3R': 0, '3R+': 0 };
    for (const t of report.trades) {
        if (t.rMultiple < 0) rBuckets['Loss (< 0R)']++;
        else if (t.rMultiple < 0.5) rBuckets['0-0.5R']++;
        else if (t.rMultiple < 1) rBuckets['0.5-1R']++;
        else if (t.rMultiple < 2) rBuckets['1-2R']++;
        else if (t.rMultiple < 3) rBuckets['2-3R']++;
        else rBuckets['3R+']++;
    }
    for (const [bucket, count] of Object.entries(rBuckets)) {
        const bar = '█'.repeat(count);
        console.log(`  ${bucket.padEnd(12)} ${count.toString().padEnd(3)} ${bar}`);
    }

    console.log('\n=== STOP DISTANCE ANALYSIS ===');
    const avgSL = report.trades.reduce((s, t) => s + t.riskR, 0) / report.trades.length;
    const minSL = Math.min(...report.trades.map(t => t.riskR));
    const maxSL = Math.max(...report.trades.map(t => t.riskR));
    console.log(`  Avg 1R (stop distance): ${avgSL.toFixed(2)} pts`);
    console.log(`  Min: ${minSL.toFixed(2)} pts | Max: ${maxSL.toFixed(2)} pts`);
}

run();
