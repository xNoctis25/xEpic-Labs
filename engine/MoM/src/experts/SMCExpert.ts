import { Candle } from '../market/CandleAggregator';

export class SMCExpert {
    private candles: Candle[] = [];

    // --- Session VWAP ---
    // Resets each trading day to provide intraday price context
    private cumVolPrice: number = 0;
    private cumVol: number = 0;
    private currentDay: number = -1;

    // --- Setup Rejection Log (clears daily) ---
    // Tracks why valid FVG gaps were rejected by secondary filters
    public dailyRejectedSetups: string[] = [];
    private rejectionDay: number = -1;

    public analyze(candle: Candle): 'BUY' | 'SELL' | 'HOLD' {
        this.candles.push(candle);

        // ==========================================
        // Session VWAP Calculation (resets daily)
        // ==========================================
        const daySlot = Math.floor(candle.timestamp / 86400000);
        if (daySlot !== this.currentDay) {
            // New trading day — reset VWAP accumulators
            this.cumVolPrice = 0;
            this.cumVol = 0;
            this.currentDay = daySlot;
        }
        // Clear rejection log on new day
        if (daySlot !== this.rejectionDay) {
            this.dailyRejectedSetups = [];
            this.rejectionDay = daySlot;
        }

        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        this.cumVolPrice += typicalPrice * candle.volume;
        this.cumVol += candle.volume;
        const vwap = this.cumVol > 0 ? this.cumVolPrice / this.cumVol : 0;

        // VWAP must be valid to proceed
        if (vwap <= 0) return 'HOLD';

        // ==========================================
        // SMC Signal: Fair Value Gap (FVG) + Market Structure Shift (MSS)
        // ==========================================
        // Need 19 candles: 15 lookback for MSS + 4 for FVG (c1, c2, c3, curr)
        const len = this.candles.length;
        if (len < 19) return 'HOLD';

        const c1   = this.candles[len - 4]; // Candle 1 — defines one edge of the gap
        const c2   = this.candles[len - 3]; // Candle 2 — the displacement (impulse) candle
        const c3   = this.candles[len - 2]; // Candle 3 — defines the other edge of the gap
        const curr = this.candles[len - 1]; // Current candle — testing for tap into the gap

        // MSS Lookback: 15 candles immediately before the FVG formation
        const lookback = this.candles.slice(len - 19, len - 4);
        const highestHigh = Math.max(...lookback.map(c => c.high));
        const lowestLow = Math.min(...lookback.map(c => c.low));

        // Volume Validation: average volume of the lookback window
        const avgVolume = lookback.reduce((sum, c) => sum + c.volume, 0) / lookback.length;

        // Timestamp for rejection logging
        const timeStr = new Date(candle.timestamp).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });

        // --- Bullish FVG ---
        // A gap exists when c1's high is below c3's low (price jumped up, leaving a void)
        if (c1.high < c3.low) {
            const gapSize = c3.low - c1.high;
            if (gapSize >= 2.0) {
                // Gap is structurally valid — check secondary filters
                if (c3.low <= vwap) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bullish FVG rejected (Price below VWAP).`);
                } else if (c2.close <= highestHigh) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bullish FVG rejected (MSS failed — no structure break).`);
                } else if (c2.volume <= avgVolume * 1.5) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bullish FVG rejected (Volume spike insufficient).`);
                } else {
                    // All filters passed — check for tap entry
                    if (curr.low <= c3.low && curr.close > c1.high) {
                        return 'BUY';  // Bullish FVG Tap — MSS + Volume Spike + VWAP confirmed
                    }
                }
            }
        }

        // --- Bearish FVG ---
        // A gap exists when c1's low is above c3's high (price dropped down, leaving a void)
        if (c1.low > c3.high) {
            const gapSize = c1.low - c3.high;
            if (gapSize >= 2.0) {
                // Gap is structurally valid — check secondary filters
                if (c3.high >= vwap) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bearish FVG rejected (Price above VWAP).`);
                } else if (c2.close >= lowestLow) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bearish FVG rejected (MSS failed — no structure break).`);
                } else if (c2.volume <= avgVolume * 1.5) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bearish FVG rejected (Volume spike insufficient).`);
                } else {
                    // All filters passed — check for tap entry
                    if (curr.high >= c3.high && curr.close < c1.low) {
                        return 'SELL'; // Bearish FVG Tap — MSS + Volume Spike + VWAP confirmed
                    }
                }
            }
        }

        return 'HOLD';
    }

    /**
     * Clears the daily rejected setups log. Called by the EoDR generator after archiving.
     */
    public clearDailyRejections(): void {
        this.dailyRejectedSetups = [];
    }
}
