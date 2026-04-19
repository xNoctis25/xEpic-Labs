import 'dotenv/config';
import { DataLoader } from './DataLoader';
import { BacktestEngine } from './BacktestEngine';
import { config } from '../config/env';

async function run() {
    // Resolve continuous contract symbol based on INDICES config
    const symbol = config.INDICES === 'ES' ? 'ES.c.0' : 'MES.c.0';

    console.log("=== M.o.M Backtest Engine ===");
    console.log(`[Backtest Preflight] Capital: $${config.BACKTEST_CAPITAL} | Index: ${config.INDICES} | Risk: ${config.RISK}%`);
    console.log(`[Backtest Preflight] Symbol: ${symbol}\n`);

    // Simulate 3 months of data
    const startDate = new Date('2026-01-01T00:00:00Z');
    const endDate = new Date('2026-03-31T23:59:59Z');

    const candles = await DataLoader.loadHistoricalData(symbol, startDate, endDate);

    const engine = new BacktestEngine(config.BACKTEST_CAPITAL);
    const report = await engine.runStandardBacktest(candles, symbol);

    console.log("\n=== Backtest Report ===");
    console.log(`Total Trades: ${report.totalTrades}`);
    console.log(`Win Rate: ${report.winRate.toFixed(2)}%`);
    console.log(`Net Profit: $${report.netProfit.toFixed(2)}`);
    console.log(`Max Drawdown: ${report.maxDrawdown.toFixed(2)}%`);
    console.log(`Starting Equity: $${report.startingEquity.toFixed(2)}`);
    console.log(`Ending Equity: $${report.endingEquity.toFixed(2)}`);
}

run();
