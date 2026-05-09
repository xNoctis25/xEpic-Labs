import pool from '../db';
import fetch from 'node-fetch'; // if needed, but fetch is native in Node 24

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

// ── FMP ECONOMIC EVENT ENGINE ──────────────────────────────────────────────────
const MAJORS = ['US', 'GB', 'EU', 'CA', 'AU', 'JP'];
const FLAG_MAP: Record<string, string> = { 'US': '🇺🇸', 'GB': '🇬🇧', 'EU': '🇪🇺', 'CA': '🇨🇦', 'AU': '🇦🇺', 'JP': '🇯🇵' };
const FMP_API_KEY = process.env.FMP_API_KEY || '';

export async function syncFmpEvents() {
    if (!FMP_API_KEY) {
        console.error('[NYCommand] Missing FMP_API_KEY. Skipping economic event sync.');
        return;
    }
    try {
        const today = new Date().toISOString().split('T')[0];
        const nextWeekDate = new Date();
        nextWeekDate.setDate(nextWeekDate.getDate() + 7);
        const nextWeek = nextWeekDate.toISOString().split('T')[0];
        
        console.log(`[NYCommand] Fetching FMP Economic Calendar: ${today} to ${nextWeek}`);
        const res = await fetch(`https://financialmodelingprep.com/stable/economic-calendar?from=${today}&to=${nextWeek}&apikey=${FMP_API_KEY}`);
        if (!res.ok) throw new Error(`FMP API Error: ${res.statusText}`);
        
        const data = (await res.json()) as any[];
        let inserted = 0;
        
        for (const evt of data) {
            if (!evt.impact || evt.impact === 'Low' || !evt.country || !MAJORS.includes(evt.country)) continue;
            
            const eventId = `${evt.country}_${evt.event}_${evt.date}`.replace(/\s+/g, '_');
            const eventDate = new Date(evt.date + "Z");
            const blackoutStart = new Date(new Date(evt.date + "Z").getTime() - 15 * 60 * 1000);
            const blackoutEnd = new Date(new Date(evt.date + "Z").getTime() + 15 * 60 * 1000);
            
            await pool.query(`
                INSERT INTO economic_events (
                    id, event_name, event_date, impact, country, 
                    actual, estimate, previous, blackout_start, blackout_end
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT (id) DO UPDATE SET
                    actual = EXCLUDED.actual,
                    estimate = EXCLUDED.estimate,
                    previous = EXCLUDED.previous
            `, [
                eventId, evt.event, eventDate.toISOString(), evt.impact, evt.country,
                evt.actual ?? null, evt.estimate ?? null, evt.previous ?? null,
                blackoutStart.toISOString(), blackoutEnd.toISOString()
            ]);
            inserted++;
        }
        console.log(`[NYCommand] Synced ${inserted} High/Medium FMP Events.`);
    } catch (e) {
        console.error('[NYCommand] Failed to sync FMP events:', e);
    }
}

export function startFmpTickEngine() {
    setInterval(async () => {
        try {
            const startRes = await pool.query(`
                SELECT id, event_name, country FROM economic_events
                WHERE blackout_start <= NOW() AND notified_start = FALSE AND is_archived = FALSE
            `);
            for (const row of startRes.rows) {
                const flag = FLAG_MAP[row.country] || '🌐';
                await pool.query('INSERT INTO notifications (event_type, message) VALUES ($1, $2)', ['fmp_alert', `${flag} Blackout STARTED: ${row.event_name}`]);
                await pool.query('UPDATE economic_events SET notified_start = TRUE WHERE id = $1', [row.id]);
            }
            
            const endRes = await pool.query(`
                SELECT id, event_name, country FROM economic_events
                WHERE blackout_end <= NOW() AND notified_end = FALSE AND is_archived = FALSE
            `);
            for (const row of endRes.rows) {
                const flag = FLAG_MAP[row.country] || '🌐';
                await pool.query('INSERT INTO notifications (event_type, message) VALUES ($1, $2)', ['fmp_clear', `${flag} Blackout ENDED: ${row.event_name}`]);
                await pool.query('UPDATE economic_events SET notified_end = TRUE, is_archived = TRUE WHERE id = $1', [row.id]);
            }
        } catch (e) {
            console.error('[NYCommand] FMP Tick Engine Error:', e);
        }
    }, 10000);
}
