import express from 'express';
import pool from '../db';
import { authenticateJWT } from '../middleware/security';
import { sseClients } from '../services/nycommand';

const router = express.Router();

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
router.post('/notifications', async (req, res) => {
    try {
        const { event_type, message } = req.body;
        await pool.query('INSERT INTO notifications (event_type, message) VALUES ($1, $2)', [event_type || 'info', message]);
        res.status(201).json({ message: 'Notification created' });
    } catch (err) {
        res.status(500).json({ error: 'Failed to create notification' });
    }
});

router.get('/notifications', authenticateJWT, async (req, res) => {
    try {
        const page       = Math.max(1, parseInt(req.query.page  as string) || 1);
        const limit      = Math.min(50, parseInt(req.query.limit as string) || 20);
        const unreadOnly = req.query.unread_only === 'true';
        const offset     = (page - 1) * limit;
        const whereClause = unreadOnly ? 'WHERE read = FALSE' : '';

        const [rowsRes, countRes, unreadRes] = await Promise.all([
            pool.query(
                `SELECT id, event_type, message, read, created_at
                   FROM notifications ${whereClause}
                  ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            pool.query(`SELECT COUNT(*) AS cnt FROM notifications ${whereClause}`),
            pool.query(`SELECT COUNT(*) AS cnt FROM notifications WHERE read = FALSE`),
        ]);
        res.status(200).json({
            notifications: rowsRes.rows,
            total:  parseInt(countRes.rows[0].cnt,  10),
            unread: parseInt(unreadRes.rows[0].cnt, 10),
            page,
            limit,
        });
    } catch (error: any) {
        console.error('[API ERROR] /notifications GET:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.patch('/notifications/read-all', authenticateJWT, async (req, res) => {
    try {
        await pool.query(`UPDATE notifications SET read = TRUE WHERE read = FALSE`);
        res.status(200).json({ message: 'All notifications marked as read.' });
    } catch (error: any) {
        console.error('[API ERROR] /notifications/read-all PATCH:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.patch('/notifications/:id/read', authenticateJWT, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(`UPDATE notifications SET read = TRUE WHERE id = $1`, [id]);
        res.status(200).json({ message: 'Notification marked as read.' });
    } catch (error: any) {
        console.error('[API ERROR] /notifications/:id/read PATCH:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.get('/notifications/unread-count', authenticateJWT, async (req, res) => {
    try {
        const res2 = await pool.query(`SELECT COUNT(*) AS cnt FROM notifications WHERE read = FALSE`);
        res.status(200).json({ unread: parseInt(res2.rows[0].cnt, 10) });
    } catch (error: any) {
        console.error('[API ERROR] /notifications/unread-count GET:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.delete('/notifications/:id', authenticateJWT, async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query(`DELETE FROM notifications WHERE id = $1`, [id]);
        res.status(200).json({ message: 'Notification deleted.' });
    } catch (error: any) {
        console.error('[API ERROR] /notifications/:id DELETE:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.delete('/notifications', authenticateJWT, async (req, res) => {
    try {
        await pool.query(`DELETE FROM notifications`);
        res.status(200).json({ message: 'All notifications cleared.' });
    } catch (error: any) {
        console.error('[API ERROR] /notifications DELETE:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ── SSE STREAM ENDPOINT ───────────────────────────────────────────────────────
import jwt from 'jsonwebtoken';
const JWT_SECRET = process.env.JWT_SECRET!;

router.get('/notifications/stream', (req: any, res: any) => {
    const token = req.query.token as string | undefined;
    if (!token) return res.status(401).end();
    try { jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).end(); }

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');  
    res.flushHeaders();

    res.write(`event: connected\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

    sseClients.add(res);
    console.log(`[SSE] Client connected (${sseClients.size} total)`);

    const hb = setInterval(() => {
        try { res.write(':heartbeat\n\n'); }
        catch { clearInterval(hb); }
    }, 25_000);

    req.on('close', () => {
        clearInterval(hb);
        sseClients.delete(res);
        console.log(`[SSE] Client disconnected (${sseClients.size} remaining)`);
    });
});

// ── ECONOMIC EVENTS ───────────────────────────────────────────────────────────
router.get('/events', authenticateJWT, async (req: any, res: any) => {
    try { 
        const result = await pool.query(`
            SELECT * FROM economic_events 
            WHERE is_archived = FALSE AND event_date >= NOW() - INTERVAL '1 day'
            ORDER BY event_date ASC
        `);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API ERROR] /events GET:', err);
        res.status(500).json({ error: 'Failed to fetch events' });
    }
});

// ── GLOBAL RISK PROFILE ───────────────────────────────────────────────────────
router.patch('/risk', authenticateJWT, async (req, res) => {
    try {
        const { risk_profile } = req.body;
        if (!['SAFE', 'AGGRESSIVE'].includes(risk_profile)) {
            return res.status(400).json({ message: 'Invalid risk profile.' });
        }
        await pool.query('UPDATE prop_accounts SET risk_profile = $1', [risk_profile]);
        res.status(200).json({ message: 'Global risk updated', risk_profile });
    } catch (error) {
        console.error('[API ERROR] /risk PATCH:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

export default router;
