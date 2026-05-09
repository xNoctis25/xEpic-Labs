import express from 'express';
import pool from '../db';
import { authenticateJWT } from '../middleware/security';

const router = express.Router();

router.get('/', authenticateJWT, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM prop_accounts ORDER BY created_at ASC');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('[API ERROR] /prop-accounts GET:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.post('/', authenticateJWT, async (req, res) => {
    try {
        const { account_name, firm, phase, risk_profile, account_size } = req.body;

        if (!account_name || !firm || !phase || !risk_profile || !account_size) {
            return res.status(400).json({ message: 'All fields are required.' });
        }

        if (!['EVAL', 'FUNDED'].includes(phase) || !['SAFE', 'AGGRESSIVE'].includes(risk_profile)) {
            return res.status(400).json({ message: 'Invalid phase or risk profile enum.' });
        }

        const metricsRes = await pool.query(
            'SELECT profit_target, max_loss_limit, max_position_size FROM prop_firm_metrics WHERE firm_name = $1 AND account_size = $2',
            [firm, account_size]
        );

        if (metricsRes.rows.length === 0) {
            return res.status(400).json({ message: 'Unsupported firm or account size.' });
        }

        const metrics = metricsRes.rows[0];

        const result = await pool.query(`
            INSERT INTO prop_accounts (account_name, firm, phase, risk_profile, account_size, profit_target, max_loss_limit, max_position_size, current_pnl, best_day_pnl, days_traded, status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 0, 0, 0, 'ACTIVE')
            RETURNING *
        `, [account_name, firm, phase, risk_profile, account_size, metrics.profit_target, metrics.max_loss_limit, metrics.max_position_size]);

        console.log(`[API] ✅ Prop Firm Account Added: ${account_name} (${phase})`);
        res.status(201).json(result.rows[0]);
    } catch (error: any) {
        console.error('[API ERROR] /prop-accounts POST:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.patch('/:id', authenticateJWT, async (req, res) => {
    try {
        const { id } = req.params;
        const { account_name, status, account_balance } = req.body;
        if (!account_name && !status && account_balance === undefined) {
            return res.status(400).json({ message: 'Nothing to update.' });
        }
        if (status && !['ACTIVE', 'PAUSED', 'BLOWN'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status value.' });
        }
        const result = await pool.query(
            `UPDATE prop_accounts SET
                account_name    = COALESCE($1, account_name),
                status          = COALESCE($2, status),
                account_balance = COALESCE($3, account_balance)
             WHERE id = $4 RETURNING *`,
            [account_name || null, status || null, account_balance ?? null, id]
        );
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        console.log(`[API] ✅ Prop Firm Account Updated: ID ${id}`);
        res.status(200).json(result.rows[0]);
    } catch (error: any) {
        console.error('[API ERROR] /prop-accounts PATCH:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.delete('/:id', authenticateJWT, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await pool.query('DELETE FROM prop_accounts WHERE id = $1 RETURNING id', [id]);
        if (result.rowCount === 0) {
            return res.status(404).json({ message: 'Account not found.' });
        }
        console.log(`[API] ✅ Prop Firm Account Deleted: ID ${id}`);
        res.status(200).json({ message: 'Account deleted.' });
    } catch (error: any) {
        console.error('[API ERROR] /prop-accounts DELETE:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

export default router;
