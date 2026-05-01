/**
 * DatabentoHistoricalService.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Queries the Databento REST API for historical OHLCV-1m data to hydrate
 * worker state before the live feed starts.
 *
 * Endpoint: https://hist.databento.com/v0/timeseries/get_range
 * Auth:     HTTP Basic (API key as username, empty password)
 * Schema:   ohlcv-1m  →  returns JSONL (newline-delimited JSON)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import axios from 'axios';

const HIST_BASE_URL = 'https://hist.databento.com/v0';
const PRICE_SCALE   = 1e-9;

/** A single historical 1-minute OHLCV bar enriched with dataset + symbol. */
export interface HydrationCandle {
    open:      number;
    high:      number;
    low:       number;
    close:     number;
    volume:    number;
    timestamp: number;   // epoch ms (candle start = ts_event)
    dataset:   string;
    symbol:    string;
}

/** Full hydration payload sent to every worker via IPC. */
export interface HydrationPayload {
    cmeCandles: HydrationCandle[];
    cfeCandles: HydrationCandle[];
}

/**
 * Fetches the last `minutes` of 1-minute OHLCV bars for the given dataset + symbols.
 * Returns an empty array on any error (graceful degradation — live feed still starts).
 */
export async function hydrate(
    dataset: string,
    symbols: string[],
    minutes: number,
    endTimeMs?: number,
): Promise<HydrationCandle[]> {
    const apiKey = (process.env.DATABENTO_API_KEY || '').trim();
    if (!apiKey) {
        console.warn('[DatabentoHistorical] DATABENTO_API_KEY not set — skipping hydration.');
        return [];
    }

    const endTime   = endTimeMs ? new Date(endTimeMs) : new Date();
    const startTime = new Date(endTime.getTime() - minutes * 60_000);

    try {
        console.log(
            `[DatabentoHistorical] Fetching ${minutes}m of ohlcv-1m for ${dataset} ` +
            `[${symbols.join(', ')}] from ${startTime.toISOString()}…`
        );

        const response = await axios.get(`${HIST_BASE_URL}/timeseries.get_range?stype_in=continuous`, {
            auth:         { username: apiKey, password: '' },
            params: {
                dataset,
                symbols:  symbols.join(','),
                schema:   'ohlcv-1m',
                start:    startTime.toISOString(),
                encoding: 'json',
            },
            responseType: 'text',
            timeout:      30_000,
        });

        const candles: HydrationCandle[] = [];
        const lines = (response.data as string).split('\n').filter(l => l.trim().length > 0);

        for (const line of lines) {
            try {
                const rec = JSON.parse(line) as Record<string, unknown>;

                // ts_event is nanoseconds — use BigInt to avoid precision loss
                const tsNs = BigInt(rec.ts_event as string);
                const tsMs = Number(tsNs / 1_000_000n);

                // Prices are raw fixed-point integers (multiply by 1e-9)
                const toPrice = (v: unknown) => Number(v) * PRICE_SCALE;

                candles.push({
                    open:      toPrice(rec.open),
                    high:      toPrice(rec.high),
                    low:       toPrice(rec.low),
                    close:     toPrice(rec.close),
                    volume:    Number(rec.volume),
                    timestamp: tsMs,
                    dataset,
                    symbol:    symbols[0],  // Each feed is queried separately per dataset — symbols[0] is correct
                });
            } catch {
                // skip malformed JSONL lines
            }
        }

        console.log(`[DatabentoHistorical] ✅ ${dataset}: ${candles.length} candles loaded.`);
        return candles;

    } catch (err: any) {
        // HTTP error or timeout — degrade gracefully, live feed still starts
        console.warn(
            `[DatabentoHistorical] ⚠️  Hydration failed for ${dataset}: ` +
            `${err.response?.status ?? ''} ${err.message}. Starting cold.`
        );
        return [];
    }
}
