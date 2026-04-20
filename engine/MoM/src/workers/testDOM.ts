import 'dotenv/config';
import { TradovateBroker } from '../brokers/TradovateBroker';
import { Level2DataStore } from './Level2DataStore';
import { ContractBuilder } from '../utils/ContractBuilder';
import { config } from '../config/env';

/**
 * testDOM.ts — Standalone Level 2 DOM Diagnostic
 *
 * Verifies the full SharedArrayBuffer pipeline in isolation:
 *   1. Authenticates with Tradovate via the existing broker client
 *   2. Spawns Level2DataStore (Core 2 worker thread)
 *   3. Polls readSnapshot() every 500ms from the main thread
 *   4. Renders a live visual DOM display (top 3 bids + asks)
 *   5. Auto-exits after 30 seconds
 *
 * Usage:
 *   npm run test:dom
 *   — or —
 *   npx ts-node src/workers/testDOM.ts
 */

const TEST_DURATION_MS = 30_000; // 30 seconds
const POLL_INTERVAL_MS = 500;    // 500ms reads

// ─── ANSI Color Codes ─────────────────────────────────────────────
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const CYAN = '\x1b[36m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const YELLOW = '\x1b[33m';

async function main(): Promise<void> {
    const symbol = ContractBuilder.getActiveContract(config.INDICES);

    console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}`);
    console.log(`${BOLD}${CYAN}  M.o.M Level 2 DOM Diagnostic — SharedArrayBuffer${RESET}`);
    console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}\n`);
    console.log(`${DIM}Symbol:${RESET}   ${BOLD}${symbol}${RESET} (${config.INDICES})`);
    console.log(`${DIM}Duration:${RESET} ${TEST_DURATION_MS / 1000}s`);
    console.log(`${DIM}Poll:${RESET}     ${POLL_INTERVAL_MS}ms\n`);

    // ── Step 1: Authenticate ──────────────────────────────────────
    console.log(`${YELLOW}[Step 1/3]${RESET} Authenticating with Tradovate...`);
    const broker = new TradovateBroker();

    try {
        const connected = await broker.connect();
        if (!connected) {
            console.error(`${RED}✗ Authentication FAILED. Aborting.${RESET}`);
            process.exit(1);
        }
    } catch (err: any) {
        console.error(`${RED}✗ Connection error: ${err.message}${RESET}`);
        process.exit(1);
    }

    const token = broker.getAccessToken();
    console.log(`${GREEN}✓ Authenticated.${RESET} Token: ${DIM}${token.slice(0, 12)}...${RESET}\n`);

    // ── Step 2: Spawn Level2DataStore ─────────────────────────────
    console.log(`${YELLOW}[Step 2/3]${RESET} Spawning Level2DataStore worker (Core 2)...`);
    const l2Store = new Level2DataStore(token, symbol);
    console.log(`${GREEN}✓ Worker spawned.${RESET} Waiting for DOM data...\n`);

    // ── Step 3: Poll & Render ─────────────────────────────────────
    console.log(`${YELLOW}[Step 3/3]${RESET} Polling SharedArrayBuffer every ${POLL_INTERVAL_MS}ms...\n`);

    let readCount = 0;
    let successCount = 0;

    const pollTimer = setInterval(() => {
        readCount++;
        const snapshot = l2Store.readSnapshot();

        if (!snapshot) {
            process.stdout.write(`\r${DIM}[Read #${readCount}] Waiting for DOM data...${RESET}      `);
            return;
        }

        successCount++;

        // Clear previous output
        process.stdout.write('\x1b[2J\x1b[H');

        // Timestamp
        const ts = new Date(snapshot.timestamp);
        const etStr = ts.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
        });

        console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}`);
        console.log(`${BOLD}${CYAN}  DOM Snapshot — ${symbol} — ${etStr} ET${RESET}`);
        console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}`);
        console.log(`${DIM}Read #${readCount} | Success #${successCount} | Depth: ${snapshot.bids.length}×${snapshot.offers.length}${RESET}\n`);

        // ── Top 3 Asks (ascending order, best ask at bottom) ──
        const asks = snapshot.offers.slice(0, 3).reverse();
        console.log(`  ${DIM}───────── ASKS (Sellers) ─────────${RESET}`);
        for (const level of asks) {
            const bar = '█'.repeat(Math.min(Math.round(level.size / 5), 40));
            console.log(`  ${RED}${level.price.toFixed(2).padStart(10)}  ${level.size.toString().padStart(6)}  ${bar}${RESET}`);
        }

        // ── Spread ──
        const bestBid = snapshot.bids[0]?.price ?? 0;
        const bestAsk = snapshot.offers[0]?.price ?? 0;
        const spread = bestAsk - bestBid;
        console.log(`  ${BOLD}${YELLOW}  ─── Spread: ${spread.toFixed(2)} pts ───${RESET}`);

        // ── Top 3 Bids (descending order, best bid at top) ──
        const bids = snapshot.bids.slice(0, 3);
        for (const level of bids) {
            const bar = '█'.repeat(Math.min(Math.round(level.size / 5), 40));
            console.log(`  ${GREEN}${level.price.toFixed(2).padStart(10)}  ${level.size.toString().padStart(6)}  ${bar}${RESET}`);
        }
        console.log(`  ${DIM}───────── BIDS (Buyers) ──────────${RESET}\n`);

        // ── Imbalance ──
        const totalBids = snapshot.bids.reduce((s, l) => s + l.size, 0);
        const totalAsks = snapshot.offers.reduce((s, l) => s + l.size, 0);
        const ratio = totalAsks > 0 ? (totalBids / totalAsks) : 0;
        const bias = ratio >= 1.2 ? `${GREEN}BULLISH${RESET}` : ratio <= 0.83 ? `${RED}BEARISH${RESET}` : `${DIM}NEUTRAL${RESET}`;
        console.log(`  ${DIM}Total Bids:${RESET} ${totalBids}  ${DIM}Total Asks:${RESET} ${totalAsks}  ${DIM}Ratio:${RESET} ${ratio.toFixed(2)}x  ${DIM}Bias:${RESET} ${bias}`);
        console.log(`\n${DIM}  Auto-exit in ${Math.max(0, Math.round((TEST_DURATION_MS - readCount * POLL_INTERVAL_MS) / 1000))}s...${RESET}`);

    }, POLL_INTERVAL_MS);

    // ── Auto-exit after TEST_DURATION_MS ──────────────────────────
    setTimeout(async () => {
        clearInterval(pollTimer);

        console.log(`\n${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}`);
        console.log(`${BOLD}${CYAN}  Diagnostic Complete${RESET}`);
        console.log(`${BOLD}${CYAN}═══════════════════════════════════════════════${RESET}`);
        console.log(`  ${DIM}Total reads:${RESET}      ${readCount}`);
        console.log(`  ${DIM}Successful reads:${RESET} ${successCount}`);
        console.log(`  ${DIM}Hit rate:${RESET}         ${readCount > 0 ? ((successCount / readCount) * 100).toFixed(1) : 0}%\n`);

        console.log(`${YELLOW}Shutting down Level2DataStore worker...${RESET}`);
        await l2Store.shutdown();
        console.log(`${GREEN}✓ Clean exit.${RESET}\n`);
        process.exit(0);
    }, TEST_DURATION_MS);
}

main().catch((err) => {
    console.error(`${RED}Fatal error: ${err.message}${RESET}`);
    process.exit(1);
});
