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

const BLOCKOUT_WINDOW_MS = 15 * 60 * 1000; // ±15 minutes

// ─── Local Cache ──────────────────────────────────────────────────
let cachedEventTimestamps: number[] = [];
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

        // Cache timestamps
        cachedEventTimestamps = highImpactUS
            .map((event: any) => {
                const ts = new Date(event.date).getTime();
                return isNaN(ts) ? null : ts;
            })
            .filter((ts): ts is number => ts !== null);

        // Cache descriptions for logging
        cachedEventDescriptions = highImpactUS.map(
            (event: any) => `${event.event} @ ${event.date} (Impact: ${event.impact})`
        );

        if (cachedEventTimestamps.length > 0) {
            sendStatus(`${cachedEventTimestamps.length} high-impact US event(s) cached.`);
            cachedEventDescriptions.forEach((desc) => {
                sendStatus(`   🔴 ${desc}`);
            });
        } else {
            sendStatus('No high-impact US events today. Clear skies. ✅');
        }

        parentPort?.postMessage({
            type: 'FETCH_COMPLETE',
            eventCount: cachedEventTimestamps.length,
            events: cachedEventDescriptions,
        });

    } catch (error: any) {
        sendError(`Failed to fetch economic calendar: ${error.message}`);
        // Still send FETCH_COMPLETE so preflight doesn't hang
        parentPort?.postMessage({
            type: 'FETCH_COMPLETE',
            eventCount: cachedEventTimestamps.length,
            events: cachedEventDescriptions,
        });
    }
}

// ─── Blockout Calculation ─────────────────────────────────────────
function isBlockoutActive(): boolean {
    const now = Date.now();
    for (let i = 0; i < cachedEventTimestamps.length; i++) {
        const diff = Math.abs(now - cachedEventTimestamps[i]);
        if (diff <= BLOCKOUT_WINDOW_MS) {
            return true;
        }
    }
    return false;
}

function getNextEvent(): { timestampMs: number; minutesUntil: number } | null {
    const now = Date.now();
    let closest: number | null = null;
    let minDiff = Infinity;

    for (const eventTs of cachedEventTimestamps) {
        const diff = eventTs - now;
        if (diff > 0 && diff < minDiff) {
            minDiff = diff;
            closest = eventTs;
        }
    }

    if (closest === null) return null;
    return { timestampMs: closest, minutesUntil: Math.round(minDiff / 60000) };
}

function pushBlockoutStatus(): void {
    parentPort?.postMessage({
        type: 'BLOCKOUT_STATUS',
        isActive: isBlockoutActive(),
        eventCount: cachedEventTimestamps.length,
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
