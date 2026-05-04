export interface Tick { price: number; volume: number; timestamp: number; side?: 'A' | 'B' | 'N'; }
export interface Candle { open: number; high: number; low: number; close: number; volume: number; buyVolume: number; sellVolume: number; timestamp: number; }

export class CandleAggregator {
    private currentCandle: Candle | null = null;
    private intervalMs: number;
    private onCandleComplete: (candle: Candle) => void;

    constructor(intervalMinutes: number, onCandleComplete: (candle: Candle) => void) {
        this.intervalMs = intervalMinutes * 60 * 1000;
        this.onCandleComplete = onCandleComplete;
    }

    public processTick(tick: Tick): void {
        // Round down the timestamp to the nearest interval to anchor the candle
        const candleStart = Math.floor(tick.timestamp / this.intervalMs) * this.intervalMs;

        if (!this.currentCandle || this.currentCandle.timestamp !== candleStart) {
            // Push the completed candle to the Experts
            if (this.currentCandle) {
                this.onCandleComplete(this.currentCandle);
            }
            // Start a new candle
            this.currentCandle = {
                open: tick.price, high: tick.price, low: tick.price, close: tick.price,
                volume: tick.volume,
                buyVolume:  tick.side === 'A' ? tick.volume : 0,
                sellVolume: tick.side === 'B' ? tick.volume : 0,
                timestamp: candleStart
            };
        } else {
            // Update the current candle with the incoming tick
            this.currentCandle.high = Math.max(this.currentCandle.high, tick.price);
            this.currentCandle.low = Math.min(this.currentCandle.low, tick.price);
            this.currentCandle.close = tick.price;
            this.currentCandle.volume += tick.volume;
            if (tick.side === 'A') this.currentCandle.buyVolume  += tick.volume;
            if (tick.side === 'B') this.currentCandle.sellVolume += tick.volume;
        }
    }

    /**
     * Emits the current incomplete candle (if any) without waiting for the next tick.
     * Useful during EOD flatten, low-volume gaps, or forced indicator updates.
     * The candle is NOT cleared — it continues accumulating if more ticks arrive.
     */
    public flush(): void {
        if (this.currentCandle) {
            this.onCandleComplete(this.currentCandle);
        }
    }
}
