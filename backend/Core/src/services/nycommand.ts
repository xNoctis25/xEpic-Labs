import pool from '../db';
import fetch from 'node-fetch'; // if needed, but fetch is native in Node 24
import moment from 'moment-timezone';

export const sseClients = new Set<any>();
let lastBroadcastTs = new Date(0).toISOString();

/**
 * Polls the DB every 5 seconds for new notifications.
 * Uses created_at timestamps (UUID primary keys aren't sequential).
 */
export async function startSsePoller(): Promise<void> {
    try {
        const maxRes = await pool.query('SELECT COALESCE(MAX(created_at), NOW()) AS max_ts FROM notifications');
        lastBroadcastTs = maxRes.rows[0]?.max_ts ?? new Date().toISOString();
        console.log(`[SSE] Poller started — watching from ${lastBroadcastTs}`);
    } catch (_) {}

    setInterval(async () => {
        if (sseClients.size === 0) return;  // nothing connected, skip
        try {
            const res = await pool.query(
                `SELECT id, event_type, message, read, created_at
                   FROM notifications WHERE created_at > $1 ORDER BY created_at ASC`,
                [lastBroadcastTs]
            );
            if (res.rows.length === 0) return;

            lastBroadcastTs = res.rows[res.rows.length - 1].created_at;
            const msg = `event: notification\ndata: ${JSON.stringify({ count: res.rows.length })}\n\n`;

            for (const client of sseClients) {
                try { client.write(msg); }
                catch (_) { sseClients.delete(client); }
            }
        } catch (_) { /* DB error — next tick will retry */ }
    }, 5_000);
}



// ── EARLY CLOSE ENGINE ─────────────────────────────────────────────────────────

const EARLY_CLOSES_2026 = [
    { date: '2026-07-03', name: 'Independence Day (Observed)', closeTimeEt: '13:15:00' },
    { date: '2026-11-27', name: 'Black Friday', closeTimeEt: '13:15:00' },
    { date: '2026-12-24', name: 'Christmas Eve', closeTimeEt: '13:15:00' }
];

const dispatchedEarlyCloses = new Set<string>();

export function startEarlyCloseEngine() {
    console.log('[NYCommand] Early Close Engine started.');
    
    // Add today as a test if needed, or just let it run.
    const todayEt = moment().tz('America/New_York').format('YYYY-MM-DD');
    // For testing: we can dynamically push an early close 2 minutes from now.
    // EARLY_CLOSES_2026.push({ date: todayEt, name: 'Test Early Close', closeTimeEt: moment().tz('America/New_York').add(2, 'minutes').format('HH:mm:ss') });

    setInterval(async () => {
        try {
            const now = moment().tz('America/New_York');
            const todayStr = now.format('YYYY-MM-DD');
            const currentTimeStr = now.format('HH:mm:ss');
            
            const earlyClose = EARLY_CLOSES_2026.find(e => e.date === todayStr);
            if (!earlyClose) return; // Not an early close day

            const closeTime = moment.tz(`${todayStr} ${earlyClose.closeTimeEt}`, 'YYYY-MM-DD HH:mm:ss', 'America/New_York');
            
            const minutesToClose = closeTime.diff(now, 'minutes');
            const secondsToClose = closeTime.diff(now, 'seconds');
            
            // Check milestones
            const checkMilestone = async (key: string, message: string, maxSec: number, minSec: number) => {
                const lockKey = `${todayStr}_${key}`;
                if (secondsToClose <= maxSec && secondsToClose >= minSec && !dispatchedEarlyCloses.has(lockKey)) {
                    dispatchedEarlyCloses.add(lockKey);
                    await pool.query('INSERT INTO notifications (event_type, message) VALUES ($1, $2)', ['market_alert', message]);
                    console.log(`[NYCommand] Dispatched Early Close Notification: ${message}`);
                }
            };

            await checkMilestone('1h', `⚠️ Market closing in 1 Hour (${earlyClose.closeTimeEt} ET) for ${earlyClose.name}.`, 3600, 3500);
            await checkMilestone('30m', `⚠️ Market closing in 30 Minutes for ${earlyClose.name}.`, 1800, 1700);
            await checkMilestone('15m', `🚨 Market closing in 15 Minutes for ${earlyClose.name}. Flatten positions.`, 900, 800);
            await checkMilestone('5m', `🚨 FINAL WARNING: Market closing in 5 Minutes!`, 300, 240);
            
            // At close exactly
            const closeKey = `${todayStr}_closed`;
            if (secondsToClose <= 0 && secondsToClose >= -60 && !dispatchedEarlyCloses.has(closeKey)) {
                dispatchedEarlyCloses.add(closeKey);
                await pool.query('INSERT INTO notifications (event_type, message) VALUES ($1, $2)', ['market_halt', `🛑 MARKET CLOSED. (${earlyClose.name} Early Close)`]);
                console.log(`[NYCommand] Dispatched Market Closed Notification.`);
            }
            
        } catch (e) {
            console.error('[NYCommand] Early Close Engine Error:', e);
        }
    }, 10000);
}

