import { TradovateBroker } from '../brokers/TradovateBroker';
import { NeonDatabase } from '../services/NeonDatabase';
import { Candle } from '../market/CandleAggregator';

/**
 * ExecutionEngine — Dynamic Scale-Out Bracket Dispatcher + Trade Self-Grading
 *
 * Responsibilities:
 *   1. Calculate TP/SL targets and fire Tradovate OSO bracket orders
 *   2. Dynamically split qty into scale-out tiers using trailing stops
 *   3. Track MFE/MAE (Max Favorable/Adverse Excursion) during trade lifespan
 *   4. Self-grade each trade on close (A/B/C/F) and journal to Neon Postgres
 *
 * Scale-Out Tiers (based on qty from PositionSizer):
 *   qty === 1  → "The Pure Runner": 1 contract with trailing stop only (no TP)
 *   qty === 2  → "The Split": 1 contract at 1:1 RR + 1 runner with trailing stop
 *   qty >= 3   → "The Institutional": TP1 at 1:1, TP2 at 1:2, Runner trailing stop
 *
 * Risk Parameters:
 *   SL = 20 points | TP1 = 1:1 (20pts) | TP2 = 1:2 (40pts)
 *   Trailing Stop: pegDifference = -SL_POINTS
 */

export interface ActiveTradeExcursion {
    side: 'BUY' | 'SELL';
    entryPrice: number;
    highestHigh: number;  // Highest price seen during the trade
    lowestLow: number;    // Lowest price seen during the trade
}

export class ExecutionEngine {
    private broker: TradovateBroker;
    private db: NeonDatabase;

    // Fixed SL offset in points (must match MoMEngine.SL_POINTS)
    private readonly SL_POINTS = 20;
    private readonly DOLLAR_PER_POINT = 5;

    // Active trade excursion tracker
    private tradeExcursion: ActiveTradeExcursion | null = null;

    constructor(broker: TradovateBroker, db: NeonDatabase) {
        this.broker = broker;
        this.db = db;
    }

    /**
     * Executes a dynamically scaled bracket order based on qty.
     *
     * Scale-Out Logic:
     *   qty === 1 → The Pure Runner (trailing stop only, no TP)
     *   qty === 2 → The Split (1:1 TP + runner)
     *   qty >= 3  → The Institutional (TP1 1:1 + TP2 1:2 + runner)
     *
     * Each tier is dispatched as a separate placeOrder/placeOSO request so
     * Tradovate tracks individual bracket legs independently.
     *
     * @param symbol       - Tradovate contract symbol (e.g., 'MESM6')
     * @param currentPrice - Current market price at signal time
     * @param side         - 'BUY' or 'SELL' from SMC
     * @param qty          - Total contract quantity from PositionSizer
     * @returns First order ID from the broker, or null if all orders failed
     */
    public async executeBracket(
        symbol: string,
        currentPrice: number,
        side: 'BUY' | 'SELL',
        qty: number = 1,
        stopPrice?: number,
    ): Promise<string | null> {
        const action: 'Buy' | 'Sell' = side === 'BUY' ? 'Buy' : 'Sell';

        // Derive SL distance: use explicit stopPrice if provided, else default 20pts
        const slDistance = stopPrice
            ? Math.abs(currentPrice - stopPrice)
            : this.SL_POINTS;

        // Calculate price targets based on direction
        const slPrice = stopPrice ?? (side === 'BUY'
            ? currentPrice - slDistance
            : currentPrice + slDistance);

        const tp1Price = side === 'BUY'
            ? currentPrice + slDistance       // 1:1 RR
            : currentPrice - slDistance;

        const tp2Price = side === 'BUY'
            ? currentPrice + (slDistance * 2)  // 1:2 RR
            : currentPrice - (slDistance * 2);

        // Trailing stop offset (always negative in Tradovate's pegDifference)
        const pegDifference = -(slDistance);

        let primaryOrderId: string | null = null;

        try {
            // ==========================================
            // qty === 1: The Pure Runner
            // ==========================================
            if (qty === 1) {
                console.log(`⚡ [ExecutionEngine] - SCALE-OUT: The Pure Runner (1 contract) | SL: ${slDistance.toFixed(1)}pts`);
                console.log(`⚡ [ExecutionEngine] - ${side} Runner: Entry ~${currentPrice} | TrailingStop: ${slDistance.toFixed(1)}pts`);

                primaryOrderId = await this.broker.placeOrder(symbol, action, 1, {
                    orderType: 'TrailingStop',
                    pegDifference,
                });

            // ==========================================
            // qty === 2: The Split
            // ==========================================
            } else if (qty === 2) {
                console.log(`⚡ [ExecutionEngine] - SCALE-OUT: The Split (2 contracts)`);

                // Order A: 1 contract with 1:1 TP + standard SL
                console.log(`⚡ [ExecutionEngine] - Leg A: ${side} ×1 | TP: ${tp1Price} (+${slDistance.toFixed(1)}pts 1:1) | SL: ${slPrice}`);
                primaryOrderId = await this.broker.placeBracketOrder(symbol, action, 1, tp1Price, slPrice);

                // Order B: 1 contract runner with trailing stop (no TP)
                console.log(`⚡ [ExecutionEngine] - Leg B: ${side} ×1 | Runner TrailingStop: ${slDistance.toFixed(1)}pts`);
                await this.broker.placeOrder(symbol, action, 1, {
                    orderType: 'TrailingStop',
                    pegDifference,
                });

            // ==========================================
            // qty >= 3: The Institutional 3-Tier
            // ==========================================
            } else {
                const runnerQty = Math.floor(qty / 3);
                const tp1Qty = Math.ceil((qty - runnerQty) / 2);
                const tp2Qty = qty - runnerQty - tp1Qty;

                console.log(`⚡ [ExecutionEngine] - SCALE-OUT: The Institutional (${qty} contracts)`);
                console.log(`⚡ [ExecutionEngine] - TP1: ×${tp1Qty} @ 1:1 | TP2: ×${tp2Qty} @ 1:2 | Runner: ×${runnerQty} trailing`);

                // Order A: TP1 tier — Take Profit at 1:1 RR + standard SL
                console.log(`⚡ [ExecutionEngine] - Leg A: ${side} ×${tp1Qty} | TP: ${tp1Price} (+${slDistance.toFixed(1)}pts 1:1) | SL: ${slPrice}`);
                primaryOrderId = await this.broker.placeBracketOrder(symbol, action, tp1Qty, tp1Price, slPrice);

                // Order B: TP2 tier — Take Profit at 1:2 RR + standard SL
                console.log(`⚡ [ExecutionEngine] - Leg B: ${side} ×${tp2Qty} | TP: ${tp2Price} (+${(slDistance * 2).toFixed(1)}pts 1:2) | SL: ${slPrice}`);
                await this.broker.placeBracketOrder(symbol, action, tp2Qty, tp2Price, slPrice);

                // Order C: Runner tier — Trailing stop only (no TP)
                console.log(`⚡ [ExecutionEngine] - Leg C: ${side} ×${runnerQty} | Runner TrailingStop: ${slDistance.toFixed(1)}pts`);
                await this.broker.placeOrder(symbol, action, runnerQty, {
                    orderType: 'TrailingStop',
                    pegDifference,
                });
            }

            console.log(`✅ [ExecutionEngine] - All scale-out legs transmitted. Primary Order ID: ${primaryOrderId}`);

            // Initialize excursion tracking for this trade
            this.tradeExcursion = {
                side,
                entryPrice: currentPrice,
                highestHigh: currentPrice,
                lowestLow: currentPrice,
            };

            return primaryOrderId;

        } catch (error: any) {
            console.error(`🔴 [ExecutionEngine] - Scale-out bracket failed:`, error.message);
            return null;
        }
    }

    // ==========================================
    // EOD KILL SWITCH — Emergency Position Flatten
    // ==========================================
    /**
     * EOD Rolling Sweeper / Failsafe Flatten — Unconditionally flattens any open position.
     * Uses a State-Reconciliation Loop ("Double-Tap Sweep") to guarantee flat state
     * and prevent accidental reverse positions from orphaned resting stops.
     *
     * @param symbol - Tradovate contract symbol (e.g., 'MESM6')
     * @returns true if the position is confirmed flat
     */
    public async flattenPosition(symbol: string): Promise<boolean> {
        console.log(`⚠️ [ExecutionEngine] - Sweeping ${symbol} for orphaned orders/positions.`);
        this.tradeExcursion = null;

        const MAX_ATTEMPTS = 3;

        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            console.log(`🧹 [ExecutionEngine] - Flatten Sweep Attempt ${attempt}/${MAX_ATTEMPTS}...`);

            // 1. Check current position to stop bleeding
            let netPos = await this.broker.getNetPositionQty(symbol);

            // 2. Liquidate if actively in a trade
            if (netPos !== 0) {
                const exitAction = netPos > 0 ? 'Sell' : 'Buy';
                const qtyToClose = Math.abs(netPos);
                console.log(`🚨 [ExecutionEngine] - Liquidating EXACT net position: ${exitAction} ${qtyToClose}x ${symbol}`);
                await this.broker.liquidatePosition(symbol, exitAction, qtyToClose);
                
                // Wait for market order to fill
                await new Promise(res => setTimeout(res, 1500));
                
                // 3. Verify position closed successfully
                netPos = await this.broker.getNetPositionQty(symbol);
                if (netPos !== 0) {
                    console.warn(`⚠️ [ExecutionEngine] - Position still not flat after liquidation (Net: ${netPos}). Looping back.`);
                    continue; // Loop back to the beginning to try exiting again
                }
            }

            // 4. Position is 0. Cancel all working orders to clear orphans.
            await this.broker.cancelAllWorkingOrders();
            await new Promise(res => setTimeout(res, 1500)); // Wait for cancels to settle

            // 5. Verify position AGAIN (Catches edge case: stop triggered right before we cancelled it)
            netPos = await this.broker.getNetPositionQty(symbol);
            if (netPos !== 0) {
                console.warn(`⚠️ [ExecutionEngine] - Accidental fill detected during cancellation! (Net: ${netPos}). Looping back.`);
                continue; // Loop back to the beginning to exit the accidental reverse position
            }

            // 6. If we reach here: Position is 0, and working orders were explicitly swept.
            console.log(`✅ [ExecutionEngine] - Position confirmed flat (0) and all orders cleared. Account secured.`);
            return true;
        }

        console.error(`🔴 [ExecutionEngine] - CRITICAL: FAILED TO FLATTEN AFTER ${MAX_ATTEMPTS} ATTEMPTS.`);
        return false;
    }

    // ==========================================
    // MFE / MAE Excursion Tracking
    // ==========================================
    /**
     * Called on every candle while a trade is active.
     * Updates the running highest high and lowest low for MFE/MAE calculation.
     */
    public updateExcursion(candle: Candle): void {
        if (!this.tradeExcursion) return;

        if (candle.high > this.tradeExcursion.highestHigh) {
            this.tradeExcursion.highestHigh = candle.high;
        }
        if (candle.low < this.tradeExcursion.lowestLow) {
            this.tradeExcursion.lowestLow = candle.low;
        }
    }

    // ==========================================
    // Trade Self-Grading Algorithm
    // ==========================================
    /**
     * Called when a position is closed. Calculates MFE/MAE, assigns a grade,
     * and journals the complete trade record to Neon Postgres.
     *
     * Grading Rubric:
     *   A: PnL > 0 AND MAE < -$25  (Hit target with minimal heat)
     *   B: PnL > 0 AND MAE >= -$25 (Hit target but took significant heat)
     *   C: PnL == 0                 (Break-even stop triggered)
     *   F: PnL < 0                  (Stopped out for loss)
     *
     * @param exitPrice - The price at which the position was closed
     * @param pnl       - The realized dollar P&L of the trade
     */
    public async gradeAndJournalTrade(exitPrice: number, pnl: number): Promise<void> {
        if (!this.tradeExcursion) return;

        const { side, entryPrice, highestHigh, lowestLow } = this.tradeExcursion;

        // Calculate MFE and MAE in dollar terms
        let mfeDollars: number;
        let maeDollars: number;

        if (side === 'BUY') {
            // LONG: MFE = how far price went UP from entry, MAE = how far DOWN
            mfeDollars = (highestHigh - entryPrice) * this.DOLLAR_PER_POINT;
            maeDollars = (lowestLow - entryPrice) * this.DOLLAR_PER_POINT; // Negative = adverse
        } else {
            // SHORT: MFE = how far price went DOWN from entry, MAE = how far UP
            mfeDollars = (entryPrice - lowestLow) * this.DOLLAR_PER_POINT;
            maeDollars = (entryPrice - highestHigh) * this.DOLLAR_PER_POINT; // Negative = adverse
        }

        // Assign grade
        let grade: string;
        if (pnl > 0 && maeDollars > -25) {
            grade = 'A'; // Clean winner — minimal heat
        } else if (pnl > 0 && maeDollars <= -25) {
            grade = 'B'; // Winner but took heat
        } else if (Math.abs(pnl) < 0.01) {
            grade = 'C'; // Break-even
        } else {
            grade = 'F'; // Loss
        }

        const notes = `${side} Entry: ${entryPrice} → Exit: ${exitPrice} | MFE: $${mfeDollars.toFixed(2)} | MAE: $${maeDollars.toFixed(2)}`;

        console.log(`📓 [ExecutionEngine] - Trade Graded: ${grade} | P&L: $${pnl.toFixed(2)} | MFE: $${mfeDollars.toFixed(2)} | MAE: $${maeDollars.toFixed(2)}`);

        // Journal to Neon Postgres
        try {
            await this.db.insertTradeJournal({
                side,
                entryPrice,
                exitPrice,
                pnl,
                mfeExcursion: mfeDollars,
                maeExcursion: maeDollars,
                grade,
                notes,
            });
        } catch (error: any) {
            console.error(`🔴 [ExecutionEngine] - Failed to journal trade:`, error.message);
        }

        // Clear the excursion tracker
        this.tradeExcursion = null;
    }

    /**
     * Returns whether a trade is currently being tracked for excursion.
     */
    public hasActiveExcursion(): boolean {
        return this.tradeExcursion !== null;
    }

    /**
     * Returns the current trade excursion state.
     * Used by ActiveTradeMonitor to read MFE/MAE without duplicating tracking.
     */
    public getTradeExcursion(): ActiveTradeExcursion | null {
        return this.tradeExcursion;
    }
}
