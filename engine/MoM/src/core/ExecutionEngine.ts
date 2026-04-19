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
     * @param side         - 'BUY' or 'SELL' from SMCExpert
     * @param qty          - Total contract quantity from PositionSizer
     * @returns First order ID from the broker, or null if all orders failed
     */
    public async executeBracket(
        symbol: string,
        currentPrice: number,
        side: 'BUY' | 'SELL',
        qty: number = 1,
    ): Promise<string | null> {
        const action: 'Buy' | 'Sell' = side === 'BUY' ? 'Buy' : 'Sell';

        // Calculate price targets based on direction
        const slPrice = side === 'BUY'
            ? currentPrice - this.SL_POINTS
            : currentPrice + this.SL_POINTS;

        const tp1Price = side === 'BUY'
            ? currentPrice + this.SL_POINTS       // 1:1 RR
            : currentPrice - this.SL_POINTS;

        const tp2Price = side === 'BUY'
            ? currentPrice + (this.SL_POINTS * 2)  // 1:2 RR
            : currentPrice - (this.SL_POINTS * 2);

        // Trailing stop offset (always negative in Tradovate's pegDifference)
        const pegDifference = -(this.SL_POINTS);

        let primaryOrderId: string | null = null;

        try {
            // ==========================================
            // qty === 1: The Pure Runner
            // ==========================================
            if (qty === 1) {
                console.log(`⚡ [ExecutionEngine] - SCALE-OUT: The Pure Runner (1 contract)`);
                console.log(`⚡ [ExecutionEngine] - ${side} Runner: Entry ~${currentPrice} | TrailingStop: ${this.SL_POINTS}pts`);

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
                console.log(`⚡ [ExecutionEngine] - Leg A: ${side} ×1 | TP: ${tp1Price} (+${this.SL_POINTS}pts 1:1) | SL: ${slPrice}`);
                primaryOrderId = await this.broker.placeBracketOrder(symbol, action, 1, tp1Price, slPrice);

                // Order B: 1 contract runner with trailing stop (no TP)
                console.log(`⚡ [ExecutionEngine] - Leg B: ${side} ×1 | Runner TrailingStop: ${this.SL_POINTS}pts`);
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
                console.log(`⚡ [ExecutionEngine] - Leg A: ${side} ×${tp1Qty} | TP: ${tp1Price} (+${this.SL_POINTS}pts 1:1) | SL: ${slPrice}`);
                primaryOrderId = await this.broker.placeBracketOrder(symbol, action, tp1Qty, tp1Price, slPrice);

                // Order B: TP2 tier — Take Profit at 1:2 RR + standard SL
                console.log(`⚡ [ExecutionEngine] - Leg B: ${side} ×${tp2Qty} | TP: ${tp2Price} (+${this.SL_POINTS * 2}pts 1:2) | SL: ${slPrice}`);
                await this.broker.placeBracketOrder(symbol, action, tp2Qty, tp2Price, slPrice);

                // Order C: Runner tier — Trailing stop only (no TP)
                console.log(`⚡ [ExecutionEngine] - Leg C: ${side} ×${runnerQty} | Runner TrailingStop: ${this.SL_POINTS}pts`);
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
}
