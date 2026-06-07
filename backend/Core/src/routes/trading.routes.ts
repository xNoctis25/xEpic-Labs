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
// ── CUSTOM USER EVENTS (CALENDAR) ─────────────────────────────────────────────
router.get('/custom-events', authenticateJWT, async (req: any, res) => {
    try {
        const userId = req.user.id;
        const result = await pool.query(
            `SELECT ce.*, fa.account_name
             FROM custom_events ce
             LEFT JOIN financial_accounts fa ON fa.id = ce.account_id
             WHERE ce.user_id = $1
             ORDER BY ce.event_date ASC`,
            [userId]
        );
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API ERROR] /custom-events GET:', err);
        res.status(500).json({ error: 'Failed to fetch custom events' });
    }
});

router.post('/custom-events', authenticateJWT, async (req: any, res) => {
    try {
        const userId = req.user.id;
        const { title, event_date, event_type, amount, account_id } = req.body;
        if (!title || !event_date || !event_type) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const result = await pool.query(
            `INSERT INTO custom_events (user_id, title, event_date, event_type, amount, account_id)
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [userId, title, event_date, event_type, amount ?? null, account_id ?? null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[API ERROR] /custom-events POST:', err);
        res.status(500).json({ error: 'Failed to create custom event' });
    }
});

router.delete('/custom-events/:id', authenticateJWT, async (req: any, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const result = await pool.query(
            'DELETE FROM custom_events WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Event not found or not owned by you' });
        }
        res.status(200).json({ message: 'Event deleted' });
    } catch (err) {
        console.error('[API ERROR] /custom-events DELETE:', err);
        res.status(500).json({ error: 'Failed to delete custom event' });
    }
});

// ── FINANCIAL ACCOUNTS ─────────────────────────────────────────────────────────
router.get('/financial-accounts', authenticateJWT, async (req: any, res) => {
    try {
        const userId = req.user.id;
        const { type } = req.query;
        const query = type
            ? 'SELECT * FROM financial_accounts WHERE user_id = $1 AND account_type = $2 ORDER BY account_name ASC'
            : 'SELECT * FROM financial_accounts WHERE user_id = $1 ORDER BY account_type ASC, account_name ASC';
        const params = type ? [userId, type] : [userId];
        const result = await pool.query(query, params);
        res.status(200).json(result.rows);
    } catch (err) {
        console.error('[API ERROR] /financial-accounts GET:', err);
        res.status(500).json({ error: 'Failed to fetch accounts' });
    }
});

router.post('/financial-accounts', authenticateJWT, async (req: any, res) => {
    try {
        const userId = req.user.id;
        const { account_name, account_type } = req.body;
        if (!account_name || !account_type) {
            return res.status(400).json({ error: 'account_name and account_type are required' });
        }
        if (!['income', 'expense'].includes(account_type)) {
            return res.status(400).json({ error: 'account_type must be income or expense' });
        }
        const result = await pool.query(
            `INSERT INTO financial_accounts (user_id, account_name, account_type)
             VALUES ($1, $2, $3)
             ON CONFLICT (user_id, account_name, account_type) DO NOTHING
             RETURNING *`,
            [userId, account_name.trim(), account_type]
        );
        if (result.rowCount === 0) {
            return res.status(409).json({ error: 'Account already exists' });
        }
        res.status(201).json(result.rows[0]);
    } catch (err) {
        console.error('[API ERROR] /financial-accounts POST:', err);
        res.status(500).json({ error: 'Failed to create account' });
    }
});

router.patch('/financial-accounts/:id', authenticateJWT, async (req: any, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const { account_name } = req.body;
        if (!account_name) {
            return res.status(400).json({ error: 'account_name is required' });
        }
        const result = await pool.query(
            `UPDATE financial_accounts SET account_name = $1
             WHERE id = $2 AND user_id = $3 RETURNING *`,
            [account_name.trim(), id, userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Account not found or not owned by you' });
        }
        res.status(200).json(result.rows[0]);
    } catch (err) {
        console.error('[API ERROR] /financial-accounts PATCH:', err);
        res.status(500).json({ error: 'Failed to update account' });
    }
});

router.delete('/financial-accounts/:id', authenticateJWT, async (req: any, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;
        const result = await pool.query(
            'DELETE FROM financial_accounts WHERE id = $1 AND user_id = $2 RETURNING id',
            [id, userId]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ error: 'Account not found or not owned by you' });
        }
        res.status(200).json({ message: 'Account deleted' });
    } catch (err) {
        console.error('[API ERROR] /financial-accounts DELETE:', err);
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

export default router;
