import { Candle } from '../market/CandleAggregator';

export class DataLoader {
    public static async loadHistoricalData(symbol: string, startDate: Date, endDate: Date): Promise<Candle[]> {
        console.log(`[DataLoader] Fetching Databento data for ${symbol}...`);

        const apiKey = process.env.DATABENTO_API_KEY;
        if (!apiKey) {
            throw new Error("DATABENTO_API_KEY is not set in environment variables.");
        }

        // Fix: Databento requires HTTP Basic Auth (API key as username, blank password)
        const authHeader = 'Basic ' + Buffer.from(apiKey + ':').toString('base64');

        const params = new URLSearchParams({
            dataset: 'GLBX.MDP3',
            schema: 'ohlcv-1m',
            symbols: symbol,
            start: startDate.toISOString(),
            end: endDate.toISOString(),
            encoding: 'json',
            stype_in: 'continuous'
        });

        const url = `https://hist.databento.com/v0/timeseries.get_range?${params.toString()}`;

        const response = await fetch(url, {
            headers: {
                'Authorization': authHeader,
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            const text = await response.text();
            throw new Error(`Databento API error (${response.status}): ${text}`);
        }

        const textData = await response.text();
        const lines = textData.split('\n').filter(line => line.trim() !== '');

        const candles: Candle[] = [];
        for (const line of lines) {
            const record = JSON.parse(line);

            // FIX: Databento hides the timestamp inside the 'hd' (header) object for EVERY candle!
            if (!record.hd || !record.hd.ts_event) continue;

            // Databento prices are integers scaled by 1e9
            candles.push({
                timestamp: Math.floor(Number(record.hd.ts_event) / 1000000),
                open: Number(record.open) / 1e9,
                high: Number(record.high) / 1e9,
                low: Number(record.low) / 1e9,
                close: Number(record.close) / 1e9,
                volume: Number(record.volume)
            });
        }

        console.log(`[DataLoader] Successfully loaded ${candles.length} real historical candles.`);
        return candles;
    }
}