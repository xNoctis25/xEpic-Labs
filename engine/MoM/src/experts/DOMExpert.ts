import { DOMSnapshot } from '../brokers/TradovateBroker';

/**
 * DOMExpert — Order Book Imbalance Analyzer (Phase 3: Triple Threat)
 *
 * Architecture:
 *   The SMC Expert dictates the "Area of Interest" (e.g., a Fair Value Gap).
 *   The DOM Expert only activates to CONFIRM execution when the SMC Expert
 *   produces a BUY or SELL signal. It reads the Level 2 DOM snapshot from
 *   the SharedArrayBuffer (written by Level2Worker on Core 2) and checks
 *   whether the order book supports the directional bias.
 *
 * Hierarchical State Machine:
 *   SMC Expert → "I want to BUY here" (FVG + MSS + Volume)
 *   DOM Expert → "The order book agrees" (Bid/Ask imbalance confirms)
 *
 * Detection Logic:
 *   1. Order Book Imbalance — Compares total size across the top 10 bid
 *      vs ask levels. Requires a minimum 1.2x ratio favoring the signal
 *      direction to approve. This filters out signals where the opposing
 *      side has overwhelming liquidity (likely to reject price).
 *
 *   2. Staleness Guard — If the DOM snapshot is empty or older than 5 seconds,
 *      the expert blocks the trade. Stale data is worse than no data.
 */

/** Maximum age (ms) of a DOM snapshot before it's considered stale. */
const MAX_STALENESS_MS = 5000; // 5 seconds

/** Minimum imbalance ratio required to confirm a signal. */
const IMBALANCE_THRESHOLD = 1.2; // 1.2x

export class DOMExpert {

    // --- Rejection Logging (for EoDR) ---
    public dailyRejectedByDOM: string[] = [];
    private rejectionDay: number = -1;

    /**
     * Analyzes the current DOM snapshot against a directional signal
     * from the SMC Expert.
     *
     * @param snapshot - Current DOM state read from the SharedArrayBuffer
     * @param signal   - 'BUY' or 'SELL' from the SMC Expert
     * @returns true if the order book confirms the signal, false to block
     */
    public analyze(snapshot: DOMSnapshot | null, signal: 'BUY' | 'SELL'): boolean {
        const timeStr = new Date().toLocaleTimeString('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
        });

        // Reset rejection log on new day
        const daySlot = Math.floor(Date.now() / 86400000);
        if (daySlot !== this.rejectionDay) {
            this.dailyRejectedByDOM = [];
            this.rejectionDay = daySlot;
        }

        // ==========================================
        // Guard 1: Empty Snapshot
        // ==========================================
        if (!snapshot) {
            console.log(`📕 [DOMExpert] - BLOCKED: No DOM data available (SAB empty or worker not connected).`);
            this.dailyRejectedByDOM.push(
                `${timeStr}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected by DOM (No DOM data available).`
            );
            return false;
        }

        // ==========================================
        // Guard 2: Staleness
        // ==========================================
        const age = Date.now() - snapshot.timestamp;
        if (age > MAX_STALENESS_MS) {
            console.log(`📕 [DOMExpert] - BLOCKED: DOM data is stale (${Math.round(age / 1000)}s old, max ${MAX_STALENESS_MS / 1000}s).`);
            this.dailyRejectedByDOM.push(
                `${timeStr}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected by DOM (Stale data: ${Math.round(age / 1000)}s).`
            );
            return false;
        }

        // ==========================================
        // Guard 3: Minimum Depth
        // ==========================================
        if (snapshot.bids.length === 0 || snapshot.offers.length === 0) {
            console.log(`📕 [DOMExpert] - BLOCKED: DOM has no bid or ask levels.`);
            this.dailyRejectedByDOM.push(
                `${timeStr}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected by DOM (Empty order book).`
            );
            return false;
        }

        // ==========================================
        // Order Book Imbalance Calculation
        // ==========================================
        const totalBidSize = snapshot.bids.reduce((sum, level) => sum + level.size, 0);
        const totalAskSize = snapshot.offers.reduce((sum, level) => sum + level.size, 0);

        // Prevent division by zero
        if (totalBidSize === 0 || totalAskSize === 0) {
            console.log(`📕 [DOMExpert] - BLOCKED: Zero liquidity on one side (Bids: ${totalBidSize}, Asks: ${totalAskSize}).`);
            this.dailyRejectedByDOM.push(
                `${timeStr}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected by DOM (Zero liquidity).`
            );
            return false;
        }

        let ratio: number;
        let approved: boolean;

        if (signal === 'BUY') {
            // For BUY: Bids must dominate Asks (buyers are stacking)
            ratio = totalBidSize / totalAskSize;
            approved = ratio >= IMBALANCE_THRESHOLD;
        } else {
            // For SELL: Asks must dominate Bids (sellers are stacking)
            ratio = totalAskSize / totalBidSize;
            approved = ratio >= IMBALANCE_THRESHOLD;
        }

        if (approved) {
            console.log(
                `📗 [DOMExpert] - CONFIRMED: ${signal} approved. ` +
                `Imbalance ratio: ${ratio.toFixed(2)}x (threshold: ${IMBALANCE_THRESHOLD}x) | ` +
                `Bids: ${totalBidSize} | Asks: ${totalAskSize}`
            );
            return true;
        } else {
            console.log(
                `📕 [DOMExpert] - BLOCKED: ${signal} rejected. ` +
                `Imbalance ratio: ${ratio.toFixed(2)}x (need ≥${IMBALANCE_THRESHOLD}x) | ` +
                `Bids: ${totalBidSize} | Asks: ${totalAskSize}`
            );
            this.dailyRejectedByDOM.push(
                `${timeStr}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected by DOM (Imbalance ${ratio.toFixed(2)}x < ${IMBALANCE_THRESHOLD}x).`
            );
            return false;
        }
    }

    /**
     * Clears the daily DOM rejection log. Called by the EoDR generator after archiving.
     */
    public clearDailyRejections(): void {
        this.dailyRejectedByDOM = [];
    }
}
