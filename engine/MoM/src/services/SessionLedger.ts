import { TradovateBroker } from '../brokers/TradovateBroker';

/**
 * SessionLedger — Real-Time Buying Power & Margin Tracker
 *
 * Architecture: "RAM-First with Ghost Sync"
 *   1. On boot, pings the broker for real cash balance (single network call).
 *   2. All runtime checks (hasSufficientMargin, reserve, release) are synchronous RAM ops.
 *   3. Background reconciliation loop silently pings the broker every 60s to correct drift.
 *
 * This ensures sub-millisecond margin checks during the hot path (trade execution)
 * while keeping the local ledger honest against the broker's ground truth.
 */
export class SessionLedger {
    private availableBuyingPower: number = 0;
    private reservedMargin: number = 0;
    private sessionPnL: number = 0;
    private reconciliationTimer: ReturnType<typeof setInterval> | null = null;

    // ==========================================
    // Boot Sync (Async — called once at startup)
    // ==========================================
    /**
     * Pings the broker for the real account cash balance and initializes the local ledger.
     * Must be called BEFORE the trading session begins.
     */
    public async initialize(broker: TradovateBroker): Promise<void> {
        console.log('💰 [Ledger] - Syncing with broker for opening balance...');

        const brokerBalance = await broker.getCashBalance();

        if (brokerBalance > 0) {
            this.availableBuyingPower = brokerBalance;
            console.log(`💰 [Ledger] - Opening Balance: $${brokerBalance.toFixed(2)}`);
        } else {
            // Fallback: if broker returns 0 (disconnected, API error), use a safe default
            this.availableBuyingPower = 1000;
            console.warn(`⚠️ [Ledger] - Broker returned $0. Using fallback: $${this.availableBuyingPower.toFixed(2)}`);
        }

        this.reservedMargin = 0;
        this.sessionPnL = 0;
        console.log(`💰 [Ledger] - Session initialized. Buying Power: $${this.availableBuyingPower.toFixed(2)}`);
    }

    // ==========================================
    // RAM Gatekeepers (Synchronous — hot path)
    // ==========================================
    /**
     * SYNCHRONOUS margin check. Returns true if the ledger has enough free buying power.
     * Executes in nanoseconds — zero network I/O.
     */
    public hasSufficientMargin(requiredMargin: number): boolean {
        return this.availableBuyingPower >= requiredMargin;
    }

    /**
     * Instantly deducts margin from buying power when a trade is opened.
     * Must be called immediately when a position is entered.
     */
    public reserveMargin(amount: number): void {
        this.availableBuyingPower -= amount;
        this.reservedMargin += amount;
        console.log(`💰 [Ledger] - Margin reserved: -$${amount.toFixed(2)} | Available: $${this.availableBuyingPower.toFixed(2)}`);
    }

    /**
     * Releases reserved margin back to buying power and applies realized P&L.
     * Called when a position is closed (TP, SL, BE, or EOD flatten).
     *
     * @param margin - The margin that was originally reserved for this trade
     * @param realizedPnL - The dollar P&L of the trade (positive for wins, negative for losses)
     */
    public releaseMarginAndApplyPnL(margin: number, realizedPnL: number): void {
        this.reservedMargin -= margin;
        this.availableBuyingPower += margin + realizedPnL;
        this.sessionPnL += realizedPnL;

        const pnlStr = realizedPnL >= 0 ? `+$${realizedPnL.toFixed(2)}` : `-$${Math.abs(realizedPnL).toFixed(2)}`;
        console.log(`💰 [Ledger] - Margin released: +$${margin.toFixed(2)} | P&L: ${pnlStr} | Available: $${this.availableBuyingPower.toFixed(2)} | Session P&L: $${this.sessionPnL.toFixed(2)}`);
    }

    // ==========================================
    // Ghost Sync (Background Reconciliation)
    // ==========================================
    /**
     * Starts a background loop that pings the broker every 60 seconds.
     * If the broker's real balance diverges from the local ledger (partial fills,
     * rejected orders, manual adjustments), silently overwrites the local value.
     *
     * This runs OUTSIDE the hot path — never blocks trade decisions.
     */
    public startBackgroundReconciliation(broker: TradovateBroker): void {
        const RECONCILE_INTERVAL_MS = 60 * 1000; // Every 60 seconds

        this.reconciliationTimer = setInterval(async () => {
            try {
                const brokerBalance = await broker.getCashBalance();

                if (brokerBalance > 0) {
                    // The broker reports TOTAL equity. Our local "available" should be
                    // total minus whatever we currently have reserved in open positions.
                    const correctedAvailable = brokerBalance - this.reservedMargin;

                    const drift = correctedAvailable - this.availableBuyingPower;
                    if (Math.abs(drift) > 0.01) {
                        const driftSign = drift > 0 ? '+' : '';
                        console.log(`👻 [Ledger] - Ghost Sync: drift detected (${driftSign}$${drift.toFixed(2)}). Syncing P&L...`);
                        this.availableBuyingPower = correctedAvailable;
                        this.sessionPnL += drift; // Update the daily P&L for the EoDR
                    }
                }
            } catch {
                // Silent fail — don't disrupt the trading loop for a background sync
            }
        }, RECONCILE_INTERVAL_MS);

        console.log('👻 [Ledger] - Background reconciliation active (60s interval).');
    }

    /**
     * Stops the background reconciliation loop (for clean shutdown).
     */
    public stopReconciliation(): void {
        if (this.reconciliationTimer) {
            clearInterval(this.reconciliationTimer);
            this.reconciliationTimer = null;
            console.log('👻 [Ledger] - Background reconciliation stopped.');
        }
    }

    // ==========================================
    // Diagnostics
    // ==========================================
    public getAvailableBuyingPower(): number {
        return this.availableBuyingPower;
    }

    public getReservedMargin(): number {
        return this.reservedMargin;
    }

    public getSessionPnL(): number {
        return this.sessionPnL;
    }
}
