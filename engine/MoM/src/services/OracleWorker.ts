/**
 * OracleWorker — Dedicated Worker Thread for Macro-Economic Analysis
 *
 * Thread Assignment: Core 3
 *
 * Runs the FMP Economic Calendar API fetching, cron scheduling, and
 * blockout window calculation entirely off the main thread. Pushes
 * state updates to the main thread via parentPort.postMessage().
 *
 * Message Protocol:
 *   Main → Worker:
 *     { type: 'FETCH_NOW' }       — Trigger immediate event fetch (preflight)
 *     { type: 'START_SCHEDULER' } — Start the 08:00 ET cron + blockout polling
 *
 *   Worker → Main:
 *     { type: 'FETCH_COMPLETE', eventCount: number, events: string[] }
 *     { type: 'BLOCKOUT_STATUS', isActive: boolean, eventCount: number,
 *       nextEvent: { timestampMs: number, minutesUntil: number } | null }
 *     { type: 'STATUS', message: string }
 *     { type: 'ERROR', message: string }
 */

import { parentPort, workerData } from 'worker_threads';
import axios from 'axios';
import cron from 'node-cron';

// ─── Config from Main Thread ──────────────────────────────────────
const { apiKey } = workerData as { apiKey: string };

// ─── Dynamic Blockout Rules ──────────────────────────────────────
// Maps event keywords (lowercased) to blockout windows (±minutes)
const BLOCKOUT_RULES: Record<string, number> = {
    'fomc': 60,
    'fed': 60,
    'cpi': 30,
    'nfp': 30,
    'payrolls': 30,
    'jobless': 5,
    'default': 15,
};

// ─── Local Cache ──────────────────────────────────────────────────
interface CachedEvent {
    timestampMs: number;
    description: string;
}
let cachedEvents: CachedEvent[] = [];
let cachedEventDescriptions: string[] = [];

// ─── Status Reporter ──────────────────────────────────────────────
function sendStatus(message: string): void {
    parentPort?.postMessage({ type: 'STATUS', message });
}

function sendError(message: string): void {
    parentPort?.postMessage({ type: 'ERROR', message });
}

// ─── FMP API Fetch ────────────────────────────────────────────────
async function fetchTodaysEvents(): Promise<void> {
    if (!apiKey) {
        sendStatus('No API key. Skipping news fetch.');
        parentPort?.postMessage({ type: 'FETCH_COMPLETE', eventCount: 0, events: [] });
        return;
    }

    const today = new Date();
    const dateStr = today.toISOString().split('T')[0];

    try {
        sendStatus(`Fetching economic calendar for ${dateStr}...`);

        const url = `https://financialmodelingprep.com/stable/economic-calendar?from=${dateStr}&to=${dateStr}&apikey=${apiKey}`;
        const response = await axios.get(url, {
            headers: {},
            timeout: 10000,
        });

        const events: any[] = response.data || [];

        // Filter: US-only + High-impact
        const highImpactUS = events.filter((event: any) => {
            const isUS = event.country === 'US' || event.currency === 'USD';
            const isHigh = (event.impact || '').toLowerCase() === 'high';
            return isUS && isHigh;
        });

        // Cache events with descriptions for dynamic blockout matching
        cachedEvents = highImpactUS
            .map((event: any) => {
                const ts = new Date(event.date).getTime();
                if (isNaN(ts)) return null;
                return { timestampMs: ts, description: event.event || '' };
            })
            .filter((e): e is CachedEvent => e !== null);

        // Cache descriptions for logging
        cachedEventDescriptions = highImpactUS.map(
            (event: any) => `${event.event} @ ${event.date} (Impact: ${event.impact})`
        );

        if (cachedEvents.length > 0) {
            sendStatus(`${cachedEvents.length} high-impact US event(s) cached.`);
            cachedEventDescriptions.forEach((desc) => {
                sendStatus(`   🔴 ${desc}`);
            });
        } else {
            sendStatus('No high-impact US events today. Clear skies. ✅');
        }

        parentPort?.postMessage({
            type: 'FETCH_COMPLETE',
            eventCount: cachedEvents.length,
            events: cachedEventDescriptions,
        });

    } catch (error: any) {
        sendError(`Failed to fetch economic calendar: ${error.message}`);
        // Still send FETCH_COMPLETE so preflight doesn't hang
        parentPort?.postMessage({
            type: 'FETCH_COMPLETE',
            eventCount: cachedEvents.length,
            events: cachedEventDescriptions,
        });
    }
}

// ─── Dynamic Blockout Calculation ─────────────────────────────────
/**
 * Determines the blockout duration for an event by matching its
 * description against BLOCKOUT_RULES keywords.
 */
function getBlockoutMs(eventDescription: string): number {
    const lower = eventDescription.toLowerCase();
    for (const [keyword, minutes] of Object.entries(BLOCKOUT_RULES)) {
        if (keyword !== 'default' && lower.includes(keyword)) {
            return minutes * 60 * 1000;
        }
    }
    return BLOCKOUT_RULES['default'] * 60 * 1000;
}

function isBlockoutActive(): boolean {
    const now = Date.now();
    for (const event of cachedEvents) {
        const windowMs = getBlockoutMs(event.description);
        const diff = Math.abs(now - event.timestampMs);
        if (diff <= windowMs) {
            return true;
        }
    }
    return false;
}

function getNextEvent(): { timestampMs: number; minutesUntil: number } | null {
    const now = Date.now();
    let closest: number | null = null;
    let minDiff = Infinity;

    for (const event of cachedEvents) {
        const diff = event.timestampMs - now;
        if (diff > 0 && diff < minDiff) {
            minDiff = diff;
            closest = event.timestampMs;
        }
    }

    if (closest === null) return null;
    return { timestampMs: closest, minutesUntil: Math.round(minDiff / 60000) };
}

function pushBlockoutStatus(): void {
    parentPort?.postMessage({
        type: 'BLOCKOUT_STATUS',
        isActive: isBlockoutActive(),
        eventCount: cachedEvents.length,
        nextEvent: getNextEvent(),
    });
}

// ─── Message Handler (Main → Worker) ──────────────────────────────
parentPort?.on('message', async (msg: any) => {
    if (msg.type === 'FETCH_NOW') {
        await fetchTodaysEvents();
        pushBlockoutStatus();
    }

    if (msg.type === 'START_SCHEDULER') {
        // Start the 08:00 ET daily cron
        cron.schedule('0 8 * * *', async () => {
            sendStatus('Daily 08:00 ET refresh triggered.');
            await fetchTodaysEvents();
            pushBlockoutStatus();
        }, {
            timezone: 'America/New_York',
        });

        sendStatus('Cron scheduler active. Daily refresh at 08:00 AM ET.');

        // Start blockout status polling every 5 seconds
        setInterval(() => {
            pushBlockoutStatus();
        }, 5000);

        sendStatus('Blockout status polling active (5s interval).');
    }
});

sendStatus('OracleWorker initialized on Core 3.');
