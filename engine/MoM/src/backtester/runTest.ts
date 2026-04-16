import 'dotenv/config';
import { DataLoader } from './DataLoader';
import { BacktestEngine } from './BacktestEngine';

async function run() {
    console.log("=== M.o.M Backtest Engine Initialization ===");

    // Simulate 3 months of data
    const startDate = new Date('2026-01-01T00:00:00Z');
    const endDate = new Date('2026-03-31T23:59:59Z');

    // MES.c.0 = Continuous front-month Micro E-Mini S&P 500 (Databento symbology)
    const symbol = 'MES.c.0';
    const candles = await DataLoader.loadHistoricalData(symbol, startDate, endDate);

    const engine = new BacktestEngine(1000); // Start with $1k capital
    const report = await engine.runStandardBacktest(candles, symbol);

    console.log("\n=== Backtest Report ===");
    console.log(`Total Trades: ${report.totalTrades}`);
    console.log(`Win Rate: ${report.winRate.toFixed(2)}%`);
    console.log(`Net Profit: $${report.netProfit.toFixed(2)}`);
    console.log(`Max Drawdown: ${report.maxDrawdown.toFixed(2)}%`);
    console.log(`Ending Equity: $${report.endingEquity.toFixed(2)}`);
}

run();
