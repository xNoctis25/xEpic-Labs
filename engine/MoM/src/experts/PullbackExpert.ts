import { SMA } from 'technicalindicators';
import { Candle } from '../market/CandleAggregator';

export class PullbackExpert {
    private closes: number[] = [];
    private typicalPrices: number[] = [];
    private volumes: number[] = [];

    public analyze(candle: Candle): 'BUY' | 'SELL' | 'HOLD' {
        this.closes.push(candle.close);
        
        // Calculate Typical Price for VWAP: (High + Low + Close) / 3
        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        this.typicalPrices.push(typicalPrice);
        this.volumes.push(candle.volume);

        // Require 60 periods to calculate a 1-Hour SMA (assuming 1-min candles)
        if (this.closes.length < 60) return 'HOLD'; 

        const smaResult = SMA.calculate({ period: 60, values: this.closes });
        const currentSMA = smaResult[smaResult.length - 1];

        // Calculate Session VWAP (Volume Weighted Average Price)
        const cumVolPrice = this.typicalPrices.reduce((acc, p, i) => acc + p * this.volumes[i], 0);
        const cumVol = this.volumes.reduce((acc, v) => acc + v, 0);
        const vwap = cumVolPrice / cumVol;

        const currentPrice = candle.close;
        const threshold = 0.50; // $0.50 tolerance to trigger a "touch"

        // Logic: Is the broader trend up (SMA > VWAP) and price pulls back to touch VWAP?
        if (currentSMA > vwap && Math.abs(currentPrice - vwap) <= threshold) {
            console.log(`🎯 [PullbackExpert] - Bullish VWAP Touch Detected in Uptrend.`);
            return 'BUY'; 
        } 
        // Logic: Is the broader trend down (SMA < VWAP) and price pops up to touch VWAP?
        else if (currentSMA < vwap && Math.abs(currentPrice - vwap) <= threshold) {
            console.log(`🎯 [PullbackExpert] - Bearish VWAP Touch Detected in Downtrend.`);
            return 'SELL'; 
        }

        return 'HOLD';
    }
}
