import { TradovateBroker } from '../brokers/TradovateBroker';
import { NeonDatabase } from '../services/NeonDatabase';
import { Candle } from '../market/CandleAggregator';

/**
 * ExecutionEngine — Live Bracket Order Dispatcher + Trade Self-Grading
 *
 * Responsibilities:
 *   1. Calculate TP/SL targets and fire Tradovate OSO bracket orders
 *   2. Track MFE/MAE (Max Favorable/Adverse Excursion) during trade lifespan
 *   3. Self-grade each trade on close (A/B/C/F) and journal to Neon Postgres
 *
 * Risk Parameters (MES — Micro E-Mini S&P 500):
 *   TP = +40 points | SL = -20 points | $5 per point
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

    // Fixed TP/SL offsets in points (must match BacktestEngine for consistency)
    private readonly TP_POINTS = 40;
    private readonly SL_POINTS = 20;
    private readonly DOLLAR_PER_POINT = 5;

    // Active trade excursion tracker
    private tradeExcursion: ActiveTradeExcursion | null = null;

    constructor(broker: TradovateBroker, db: NeonDatabase) {
        this.broker = broker;
        this.db = db;
    }

    /**
     * Executes a bracket order with calculated TP/SL targets.
     * Also initializes the MFE/MAE excursion tracker for the new trade.
     *
     * @param symbol       - Tradovate contract symbol (e.g., 'MESM6')
     * @param currentPrice - Current market price at signal time
     * @param side         - 'BUY' or 'SELL' from SMCExpert
     * @param qty          - Number of contracts (default 1)
     * @returns Order ID from the broker, or null if the order failed
     */
    public async executeBracket(
        symbol: string,
        currentPrice: number,
        side: 'BUY' | 'SELL',
        qty: number = 1,
    ): Promise<string | null> {
        // Convert internal signal format to Tradovate action format
        const action: 'Buy' | 'Sell' = side === 'BUY' ? 'Buy' : 'Sell';

        // Calculate strict targets based on direction
        let tpPrice: number;
        let slPrice: number;

        if (side === 'BUY') {
            tpPrice = currentPrice + this.TP_POINTS;  // LONG: TP above entry
            slPrice = currentPrice - this.SL_POINTS;  // LONG: SL below entry
        } else {
            tpPrice = currentPrice - this.TP_POINTS;  // SHORT: TP below entry
            slPrice = currentPrice + this.SL_POINTS;  // SHORT: SL above entry
        }

        console.log(`⚡ [ExecutionEngine] - ${side} Bracket: Entry ~${currentPrice} | TP: ${tpPrice} (+${this.TP_POINTS}pts) | SL: ${slPrice} (-${this.SL_POINTS}pts)`);

        try {
            const orderId = await this.broker.placeBracketOrder(
                symbol,
                action,
                qty,
                tpPrice,
                slPrice,
            );

            console.log(`✅ [ExecutionEngine] - Bracket transmitted successfully. Broker Order ID: ${orderId}`);

            // Initialize excursion tracking for this trade
            this.tradeExcursion = {
                side,
                entryPrice: currentPrice,
                highestHigh: currentPrice,
                lowestLow: currentPrice,
            };

            return orderId;

        } catch (error: any) {
            console.error(`🔴 [ExecutionEngine] - Failed to place bracket:`, error.message);
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
