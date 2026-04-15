import { MACD } from 'technicalindicators';
import { Candle } from '../market/CandleAggregator';

export class BreakoutExpert {
    private closes: number[] = [];

    public analyze(candle: Candle): 'BUY' | 'SELL' | 'HOLD' {
        this.closes.push(candle.close);
        
        // Wait for enough data to accurately calculate the MACD
        if (this.closes.length < 30) return 'HOLD'; 

        // Standard MACD Configuration (12, 26, 9)
        const macdInput = {
            values: this.closes,
            fastPeriod: 12,
            slowPeriod: 26,
            signalPeriod: 9,
            SimpleMAOscillator: false,
            SimpleMASignal: false
        };

        const macdResult = MACD.calculate(macdInput);
        if (macdResult.length < 2) return 'HOLD';

        const current = macdResult[macdResult.length - 1];
        const previous = macdResult[macdResult.length - 2];

        // Detect Zero-Cross Breakout / TTM Squeeze Momentum
        if (current.MACD !== undefined && previous.MACD !== undefined) {
            if (previous.MACD < 0 && current.MACD > 0) {
                console.log(`🚀 [BreakoutExpert] - Bullish MACD Zero-Cross Detected.`);
                return 'BUY';
            }
            if (previous.MACD > 0 && current.MACD < 0) {
                console.log(`📉 [BreakoutExpert] - Bearish MACD Zero-Cross Detected.`);
                return 'SELL';
            }
        }

        return 'HOLD';
    }
}
