import express from 'express';
import pool from '../db';
import { authenticateJWT } from '../middleware/security';
import { GoogleGenAI } from '@google/genai';

const router = express.Router();

router.post('/chat', authenticateJWT, async (req: any, res: any) => {
    try {
        const { message, model, history } = req.body;
        if (!message) return res.status(400).json({ message: 'Message is required.' });

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ reply: 'Nova Core Offline: Missing GEMINI_API_KEY.' });
        }

        let targetModel = 'gemini-2.5-flash';
        if (model === 'gemini-2.5-pro') {
            const roleQuery = await pool.query('SELECT role FROM users WHERE id = $1', [req.user.id]);
            if (roleQuery.rows.length > 0 && roleQuery.rows[0].role === 'admin') {
                targetModel = 'gemini-2.5-pro';
            }
        }

        const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
        if (Array.isArray(history) && history.length > 0) {
            for (const turn of history) {
                contents.push({
                    role: turn.role === 'ai' ? 'model' : 'user',
                    parts: [{ text: turn.text }]
                });
            }
        }
        contents.push({ role: 'user', parts: [{ text: message }] });

        const ai = new GoogleGenAI({ apiKey: apiKey });
        const response = await ai.models.generateContent({
            model: targetModel,
            contents,
            config: {
                systemInstruction: `You are Nova, the institutional-grade AI assistant for xEpic Labs — a professional trading and finance platform built for serious traders and analysts.

Your core expertise:
- Financial markets: equities, futures, forex, crypto, options, macro
- Smart Money Concepts (SMC): liquidity sweeps, order blocks, fair value gaps, Judas swings, market structure shifts
- Technical analysis: price action, ICT concepts, killzones (London/NY sessions), indicators
- Prop firm rules, risk management, trading psychology, position sizing
- General intelligence: science, technology, history, coding, current events, and more

Your personality:
- Confident, articulate, and substantive — never give a one-liner when depth is warranted
- Professional but personable
- When you lack real-time data, acknowledge it briefly then provide analysis
- Never refuse to engage. Always find an angle that adds value.

The user's name is: ${req.user.username}`,
            }
        });

        res.status(200).json({ reply: response.text });
    } catch (error: any) {
        console.error('[NOVA ERROR]', error);
        res.status(500).json({ reply: 'Error communicating with Nova core.', message: error.message || String(error) });
    }
});

export default router;
