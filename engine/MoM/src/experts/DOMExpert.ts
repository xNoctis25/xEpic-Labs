import { DOMSnapshot } from '../brokers/TradovateBroker';

/**
 * DOMExpert — Order Book Imbalance + Iceberg Detection + Anti-Spoofing (God-Mode)
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
 *   DOM Expert → "The order book agrees" (Imbalance + Proximity Floor)
 *
 * Detection Logic (3-Layer):
 *   1. Global Imbalance — 1.2x ratio favoring signal direction
 *   2. Proximity Floor (Iceberg) — Top 3 levels hold ≥30% of total
 *      directional volume, confirming institutional liquidity is
 *      concentrated near the current price (not distant spoofs)
 *   3. Anti-Spoofing Micro-Memory — confirmSetup() runs 3 consecutive
 *      analyze() checks 1 second apart. If liquidity vanishes between
 *      checks, the setup is flagged as a spoof and rejected.
 *
 *   Staleness Guard — If snapshot is empty or older than 5s, blocked.
 */

/** Maximum age (ms) of a DOM snapshot before it's considered stale. */
const MAX_STALENESS_MS = 5000; // 5 seconds

/** Minimum imbalance ratio required to confirm a signal. */
const IMBALANCE_THRESHOLD = 1.2; // 1.2x

/** Minimum concentration of volume in top 3 levels (Proximity Floor). */
const PROXIMITY_FLOOR = 0.30; // 30%

/** Number of top levels to check for proximity concentration. */
const TOP_LEVELS = 3;

export class DOMExpert {

    // --- Rejection Logging (for EoDR) ---
    public dailyRejectedByDOM: string[] = [];
    private rejectionDay: number = -1;

    // --- Level2 Data Source (injected by MoMEngine for confirmSetup reads) ---
    private snapshotReader: (() => DOMSnapshot | null) | null = null;

    /**
     * Sets the snapshot reader function.
     * Called by MoMEngine after Level2DataStore is initialized.
     */
    public setSnapshotReader(reader: () => DOMSnapshot | null): void {
        this.snapshotReader = reader;
    }

    /**
     * Analyzes the current DOM snapshot against a directional signal.
     * Checks both Global Imbalance (1.2x) and Proximity Floor (30%).
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
        // Layer 1: Global Order Book Imbalance
        // ==========================================
        const totalBidSize = snapshot.bids.reduce((sum, level) => sum + level.size, 0);
        const totalAskSize = snapshot.offers.reduce((sum, level) => sum + level.size, 0);

        if (totalBidSize === 0 || totalAskSize === 0) {
            console.log(`📕 [DOMExpert] - BLOCKED: Zero liquidity on one side (Bids: ${totalBidSize}, Asks: ${totalAskSize}).`);
            this.dailyRejectedByDOM.push(
                `${timeStr}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected by DOM (Zero liquidity).`
            );
            return false;
        }

        let imbalanceRatio: number;
        let imbalanceOk: boolean;

        if (signal === 'BUY') {
            imbalanceRatio = totalBidSize / totalAskSize;
            imbalanceOk = imbalanceRatio >= IMBALANCE_THRESHOLD;
        } else {
            imbalanceRatio = totalAskSize / totalBidSize;
            imbalanceOk = imbalanceRatio >= IMBALANCE_THRESHOLD;
        }

        if (!imbalanceOk) {
            console.log(
                `📕 [DOMExpert] - BLOCKED: ${signal} rejected. ` +
                `Imbalance ratio: ${imbalanceRatio.toFixed(2)}x (need ≥${IMBALANCE_THRESHOLD}x) | ` +
                `Bids: ${totalBidSize} | Asks: ${totalAskSize}`
            );
            this.dailyRejectedByDOM.push(
                `${timeStr}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected by DOM (Imbalance ${imbalanceRatio.toFixed(2)}x < ${IMBALANCE_THRESHOLD}x).`
            );
            return false;
        }

        // ==========================================
        // Layer 2: Proximity Floor (Iceberg Detection)
        // ==========================================
        let proximityOk: boolean;
        let proximityRatio: number;

        if (signal === 'BUY') {
            // LONG: Top 3 highest bid levels must hold ≥30% of total bid volume
            const top3BidVolume = snapshot.bids
                .slice(0, TOP_LEVELS)
                .reduce((sum, level) => sum + level.size, 0);
            proximityRatio = top3BidVolume / totalBidSize;
            proximityOk = proximityRatio >= PROXIMITY_FLOOR;
        } else {
            // SHORT: Top 3 lowest ask levels must hold ≥30% of total ask volume
            const top3AskVolume = snapshot.offers
                .slice(0, TOP_LEVELS)
                .reduce((sum, level) => sum + level.size, 0);
            proximityRatio = top3AskVolume / totalAskSize;
            proximityOk = proximityRatio >= PROXIMITY_FLOOR;
        }

        if (!proximityOk) {
            console.log(
                `📕 [DOMExpert] - BLOCKED: ${signal} rejected (Iceberg Check). ` +
                `Top ${TOP_LEVELS} proximity: ${(proximityRatio * 100).toFixed(1)}% (need ≥${PROXIMITY_FLOOR * 100}%) | ` +
                `Liquidity is too dispersed — possible iceberg/spoof.`
            );
            this.dailyRejectedByDOM.push(
                `${timeStr}: ${signal === 'BUY' ? 'Bullish' : 'Bearish'} FVG rejected by DOM (Proximity Floor ${(proximityRatio * 100).toFixed(1)}% < ${PROXIMITY_FLOOR * 100}%).`
            );
            return false;
        }

        // ==========================================
        // Both layers passed — Approved
        // ==========================================
        console.log(
            `📗 [DOMExpert] - CONFIRMED: ${signal} approved. ` +
            `Imbalance: ${imbalanceRatio.toFixed(2)}x (≥${IMBALANCE_THRESHOLD}x) | ` +
            `Proximity: ${(proximityRatio * 100).toFixed(1)}% (≥${PROXIMITY_FLOOR * 100}%) | ` +
            `Bids: ${totalBidSize} | Asks: ${totalAskSize}`
        );
        return true;
    }

    // ==========================================
    // Anti-Spoofing Micro-Memory (3-Second Confirmation)
    // ==========================================
    /**
     * Runs 3 consecutive analyze() checks, 1 second apart.
     * If the order book liquidity holds steady for 3 seconds, the setup
     * is confirmed as institutional (not a spoof).
     *
     * If any check fails, the setup is immediately rejected — liquidity
     * was pulled between reads, indicating a potential spoof.
     *
     * @param signal - 'BUY' or 'SELL' direction to confirm
     * @returns true if all 3 checks pass, false if any fails
     */
    public async confirmSetup(signal: 'BUY' | 'SELL'): Promise<boolean> {
        console.log(`🔒 [DOMExpert] - Anti-Spoof: Starting 3-second confirmation for ${signal}...`);

        for (let i = 0; i < 3; i++) {
            const snapshot = this.snapshotReader ? this.snapshotReader() : null;
            const passed = this.analyze(snapshot, signal);

            if (!passed) {
                console.log(
                    `🔒 [DOMExpert] - Anti-Spoof: FAILED on check ${i + 1}/3. ` +
                    `Liquidity pulled — possible spoof detected.`
                );
                return false;
            }

            console.log(`🔒 [DOMExpert] - Anti-Spoof: Check ${i + 1}/3 PASSED.`);

            // Wait 1 second before next check (skip wait on final iteration)
            if (i < 2) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        console.log(`🔒 [DOMExpert] - Anti-Spoof: CONFIRMED. Institutional liquidity held for 3 seconds.`);
        return true;
    }

    /**
     * Clears the daily DOM rejection log. Called by the EoDR generator after archiving.
     */
    public clearDailyRejections(): void {
        this.dailyRejectedByDOM = [];
    }
}
