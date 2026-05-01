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

/**
 * Polls Databento metadata.get_dataset_range until the dataset's available
 * end time covers our target timestamp. Guarantees zero-gap hydration.
 *
 * @param dataset  - GLBX.MDP3 or XCBF.PITCH
 * @param targetMs - epoch ms we need data up to (firstTickTimestamp)
 * @param timeoutMs - max wait before giving up (default 25 min)
 * @returns true if data is available, false if timed out
 */
export async function waitForDataAvailability(
    dataset: string,
    targetMs: number,
    timeoutMs: number = 25 * 60_000,
): Promise<boolean> {
    const apiKey = (process.env.DATABENTO_API_KEY || '').trim();
    if (!apiKey) return false;

    const target = new Date(targetMs);
    const deadline = Date.now() + timeoutMs;
    const POLL_INTERVAL = 30_000; // check every 30 seconds

    while (Date.now() < deadline) {
        try {
            const res = await axios.get(`${HIST_BASE_URL}/metadata.get_dataset_range`, {
                auth: { username: apiKey, password: '' },
                params: { dataset },
                timeout: 10_000,
            });
            const availableEnd = new Date(res.data?.end ?? 0);
            if (availableEnd >= target) {
                return true;
            }
            const gap = ((target.getTime() - availableEnd.getTime()) / 60_000).toFixed(1);
            console.log(`[Hydration] ${dataset}: available up to ${availableEnd.toISOString()} (need ${target.toISOString()}, gap: ${gap}min)`);
        } catch {
            // API error — continue polling
        }
        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }
    console.warn(`[Hydration] ${dataset}: timed out waiting for data availability.`);
    return false;
}

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
        const response = await axios.get(`${HIST_BASE_URL}/timeseries.get_range?stype_in=continuous`, {
            auth:         { username: apiKey, password: '' },
            params: {
                dataset,
                symbols:  symbols.join(','),
                schema:   'ohlcv-1m',
                start:    startTime.toISOString(),
                end:      endTime.toISOString(),
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

        return candles;

    } catch (err: any) {
        const body = err.response?.data ? String(err.response.data).slice(0, 200) : '';
        console.warn(
            `[Hydration] ${dataset} FAILED: ${err.response?.status ?? ''} | ` +
            `start=${startTime.toISOString()} end=${endTime.toISOString()} | ${body}`
        );
        return [];
    }
}

