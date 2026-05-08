import express from 'express';
import cors from 'cors';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from './db';
import { Resend } from 'resend';
import * as dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// --- HELPER TO EXTRACT CLIENT IP ---
const getClientIp = (req: any) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : req.socket.remoteAddress;
    return ip ? ip.trim() : 'unknown';
};

// --- GLOBAL IP BLACKLIST MIDDLEWARE ---
app.use(async (req, res, next) => {
    const ip = getClientIp(req);
    try {
        const banCheck = await pool.query('SELECT * FROM ip_blacklist WHERE ip_address = $1', [ip]);
        if (banCheck.rows.length > 0) {
            console.warn(`[SECURITY] Dropped connection from banned IP: ${ip}`);
            // Return 403 Forbidden instantly. Request dies here.
            return res.status(403).send('Forbidden: Your IP address has been permanently flagged for malicious activity.');
        }
        next();
    } catch (err) {
        console.error('[DB ERROR] IP Check failed', err);
        next(); // Fail open so real users aren't blocked by a DB glitch
    }
});

const JWT_SECRET = process.env.JWT_SECRET!;
if (!JWT_SECRET) {
    console.error('[FATAL] JWT_SECRET is not set in environment variables. Refusing to start.');
    process.exit(1);
}
const resend = new Resend(process.env.RESEND_API_KEY);

// ── SSE: real-time notification push ─────────────────────────────────────────
// Tracks all connected dashboard clients
const sseClients = new Set<any>();
let lastBroadcastId = 0;

/**
 * Polls the DB every 5 seconds for new notifications.
 * Broadcasts any new rows to all connected SSE clients.
 */
async function startSsePoller(): Promise<void> {
    try {
        const maxRes = await pool.query('SELECT COALESCE(MAX(id), 0) AS maxid FROM engine_notifications');
        lastBroadcastId = parseInt(maxRes.rows[0]?.maxid ?? '0', 10) || 0;
        console.log(`[SSE] Poller started — watching from notification id > ${lastBroadcastId}`);
    } catch (_) {}

    setInterval(async () => {
        if (sseClients.size === 0) return;  // nothing connected, skip
        try {
            const res = await pool.query(
                `SELECT id, event_type, message, read, created_at
                   FROM engine_notifications WHERE id > $1 ORDER BY id ASC`,
                [lastBroadcastId]
            );
            if (res.rows.length === 0) return;

            lastBroadcastId = res.rows[res.rows.length - 1].id;
            const msg = `event: notification\ndata: ${JSON.stringify({ count: res.rows.length })}\n\n`;

            for (const client of sseClients) {
                try { client.write(msg); }
                catch (_) { sseClients.delete(client); }
            }
        } catch (_) { /* DB error — next tick will retry */ }
    }, 5_000);
}

// --- DYNAMIC SECURITY MIGRATION (UUID) ---
pool.query(`
    CREATE TABLE IF NOT EXISTS ip_blacklist (
        ip_address VARCHAR(45) PRIMARY KEY,
        reason VARCHAR(255),
        banned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    ALTER TABLE users 
    ADD COLUMN IF NOT EXISTS failed_otp_attempts INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS otp_resends INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS failed_credential_attempts INT DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_flagged BOOLEAN DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS prop_firm_metrics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        firm_name VARCHAR(50) NOT NULL,
        account_size NUMERIC(10,2) NOT NULL,
        profit_target NUMERIC(10,2) NOT NULL,
        max_loss_limit NUMERIC(10,2) NOT NULL,
        max_position_size INT NOT NULL,
        UNIQUE(firm_name, account_size)
    );

    ALTER TABLE prop_accounts 
    ADD COLUMN IF NOT EXISTS account_size NUMERIC(10,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_loss_limit NUMERIC(10,2) DEFAULT 0,
    ADD COLUMN IF NOT EXISTS max_position_size INT DEFAULT 0;

    ALTER TABLE prop_accounts DROP CONSTRAINT IF EXISTS prop_accounts_status_check;
    ALTER TABLE prop_accounts ADD CONSTRAINT prop_accounts_status_check
        CHECK (status IN ('ACTIVE','PAUSED','PASSED','PAYOUT_READY','BLOWN'));

    ALTER TABLE prop_accounts ADD COLUMN IF NOT EXISTS account_balance NUMERIC(12,2) DEFAULT NULL;
    ALTER TABLE prop_accounts ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();

    CREATE TABLE IF NOT EXISTS engine_config (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        active_playbook VARCHAR(20) NOT NULL DEFAULT 'PROP_FIRM'
                        CHECK (active_playbook IN ('PROP_FIRM', 'CASH_ACCOUNT')),
        engine_state    VARCHAR(20) DEFAULT 'OFFLINE',
        updated_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS engine_notifications (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type  VARCHAR(30) NOT NULL,
        message     TEXT        NOT NULL,
        read        BOOLEAN     DEFAULT FALSE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS engine_halts (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        halt_type   VARCHAR(30) NOT NULL,
        is_active   BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMPTZ DEFAULT NOW()
    );
`).then(async () => {
    try {
        // Seed engine_config singleton (idempotent)
        const existing = await pool.query('SELECT id FROM engine_config LIMIT 1');
        if (existing.rows.length === 0) {
            await pool.query('INSERT INTO engine_config DEFAULT VALUES');
        }

        console.log('[DB] Seeding Topstep configurations...');
        const metrics = [
            ['Topstep', 50000, 3000, 2000, 5],
            ['Topstep', 100000, 6000, 3000, 10],
            ['Topstep', 150000, 9000, 4500, 15]
        ];
        for (const m of metrics) {
            await pool.query(`
                INSERT INTO prop_firm_metrics (firm_name, account_size, profit_target, max_loss_limit, max_position_size)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (firm_name, account_size) DO UPDATE SET
                    profit_target = EXCLUDED.profit_target,
                    max_loss_limit = EXCLUDED.max_loss_limit,
                    max_position_size = EXCLUDED.max_position_size;
            `, m);
        }
        console.log('[DB] Migration complete. ✅');
    } catch (e) {
        console.error('[DB] Failed to seed configurations', e);
    }
}).catch(err => console.error('[DB] Note: Migration skipped or already exists.'));

// ── SIGN UP ──────────────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({ message: 'Username, email, and password are required.' });
        }

        // 1. Check for duplicates
        const checkUser = await pool.query(
            'SELECT id FROM users WHERE LOWER(username) = LOWER($1) OR LOWER(email) = LOWER($2)',
            [username, email]
        );
        if (checkUser.rows.length > 0) {
            return res.status(409).json({ message: 'Username or Email already exists.' });
        }

        // 2. Hash password & generate OTP
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        // 3. Insert user row
        await pool.query(
            `INSERT INTO users (username, email, password, isverified, otp, otpexpiry, role)
             VALUES ($1, $2, $3, false, $4, NOW() + INTERVAL '15 minutes', 'user')`,
            [username, email, hashedPassword, otp]
        );

        // 4. Send verification email via Resend
        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: email,
            subject: 'Your xEpic Labs Verification Code',
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0b0c10;color:#f0f4f8;border-radius:12px;">
                    <h2 style="color:#66fcf1;margin-bottom:8px;">xEpic Labs</h2>
                    <p>Welcome, <strong>${username}</strong>!</p>
                    <p>Your 6-digit verification code is:</p>
                    <div style="font-size:2.5rem;font-weight:bold;letter-spacing:12px;color:#66fcf1;margin:24px 0;">${otp}</div>
                    <p style="color:#6b7a8d;font-size:0.85rem;">This code expires in 15 minutes. Do not share it with anyone.</p>
                </div>
            `
        });

        console.log(`[AUTH] ✅ New user created & OTP sent: ${username}`);
        res.status(201).json({ message: 'Account created. Please check your email for the verification code.' });

    } catch (error) {
        console.error('[AUTH ERROR] /signup:', error);
        res.status(500).json({ message: 'Internal server error during signup.' });
    }
});

// ── VERIFY OTP ───────────────────────────────────────────────────────────────
app.post('/api/auth/verify', async (req, res) => {
    try {
        const { username, otp } = req.body;

        if (!username || !otp) {
            return res.status(400).json({ message: 'Username and OTP are required.' });
        }

        const checkUser = await pool.query(
            'SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND otp = $2 AND otpexpiry > NOW()',
            [username, otp]
        );

        if (checkUser.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid or expired OTP.' });
        }

        const user = checkUser.rows[0];

        // Mark verified and clear OTP fields
        await pool.query(
            'UPDATE users SET isverified = true, otp = NULL, otpexpiry = NULL WHERE id = $1',
            [user.id]
        );

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        console.log(`[AUTH] ✅ User verified: ${username}`);
        res.status(200).json({ token });

    } catch (error) {
        console.error('[AUTH ERROR] /verify:', error);
        res.status(500).json({ message: 'Internal server error during verification.' });
    }
});

// ── RESEND OTP ───────────────────────────────────────────────────────────────
app.post('/api/auth/resend-otp', async (req, res) => {
    try {
        const { username } = req.body;

        const userQuery = await pool.query(
            'SELECT * FROM users WHERE LOWER(username) = LOWER($1) AND isverified = false',
            [username]
        );

        if (userQuery.rows.length === 0) {
            return res.status(404).json({ message: 'User not found or already verified.' });
        }

        const user = userQuery.rows[0];
        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await pool.query(
            "UPDATE users SET otp = $1, otpexpiry = NOW() + INTERVAL '15 minutes' WHERE id = $2",
            [otp, user.id]
        );

        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev',
            to: user.email,
            subject: 'Your new xEpic Labs Verification Code',
            html: `
                <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:32px;background:#0b0c10;color:#f0f4f8;border-radius:12px;">
                    <h2 style="color:#66fcf1;margin-bottom:8px;">xEpic Labs</h2>
                    <p>Your new verification code is:</p>
                    <div style="font-size:2.5rem;font-weight:bold;letter-spacing:12px;color:#66fcf1;margin:24px 0;">${otp}</div>
                    <p style="color:#6b7a8d;font-size:0.85rem;">This code expires in 15 minutes.</p>
                </div>
            `
        });

        console.log(`[AUTH] 🔁 OTP resent: ${username}`);
        res.status(200).json({ message: 'New OTP sent to your email.' });

    } catch (error) {
        console.error('[AUTH ERROR] /resend-otp:', error);
        res.status(500).json({ message: 'Internal server error during OTP resend.' });
    }
});

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        if (!username || !password) {
            return res.status(400).json({ message: 'Username and password are required.' });
        }

        const userQuery = await pool.query(
            'SELECT * FROM users WHERE LOWER(username) = LOWER($1)',
            [username]
        );

        if (userQuery.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }

        const user = userQuery.rows[0];

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }

        if (!user.isverified) {
            return res.status(403).json({ requiresVerification: true, message: 'Account not verified. Please check your email.' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        console.log(`[AUTH] ✅ Login success: ${username}`);
        res.status(200).json({ token });

    } catch (error) {
        console.error('[AUTH ERROR] /login:', error);
        res.status(500).json({ message: 'Internal server error during login.' });
    }
});

// ── ME (Protected) ────────────────────────────────────────────────────────────
app.get('/api/auth/me', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'No token provided.' });
        }

        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET) as { id: string; username: string; role: string };

        const userQuery = await pool.query(
            'SELECT id, username, email, isverified, role, createdat AS created_at FROM users WHERE id = $1',
            [decoded.id]
        );

        if (userQuery.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }

        res.status(200).json(userQuery.rows[0]);

    } catch (error: any) {
        console.error('[AUTH ERROR] /me token verification failed:', error?.message || error);
        res.status(401).json({ message: 'Invalid or expired token.' });
    }
});

// ── LOGOUT ────────────────────────────────────────────────────────────────────
app.post('/api/auth/logout', (_req, res) => {
    // JWT is stateless — client clears the token
    res.status(200).json({ message: 'Logged out successfully.' });
});

// ── REAL-TIME EXISTENCE CHECK ─────────────────────────────────────────────────
app.post('/api/auth/check-exists', async (req, res) => {
    try {
        const { field, value } = req.body;

        // Allowlist — never interpolate arbitrary column names
        if (field !== 'username' && field !== 'email') {
            return res.status(400).json({ message: 'Invalid field parameter.' });
        }

        const query = field === 'username'
            ? 'SELECT id FROM users WHERE LOWER(username) = LOWER($1)'
            : 'SELECT id FROM users WHERE LOWER(email) = LOWER($1)';

        const check = await pool.query(query, [value]);
        res.status(200).json({ exists: check.rows.length > 0 });

    } catch (error) {
        console.error('[AUTH ERROR] /check-exists:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// --- FORGOT PASSWORD (HONEYPOT PROTECTED) ---
app.post('/api/auth/forgot-password', async (req, res) => {
    try {
        const { username, email } = req.body;
        
        // 1. Query by email first to see if the target exists
        const userQuery = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        
        if (userQuery.rows.length === 0) {
            // Cannot track non-existent emails easily without IP bans. Delay and reject.
            await new Promise(resolve => setTimeout(resolve, 500));
            return res.status(400).json({ message: 'Credentials do not match.' });
        }
        
        const user = userQuery.rows[0];

        // 2. If already flagged, spring the Honeypot Trap immediately!
        if (user.is_flagged) {
            console.warn(`[SECURITY] Honeypot triggered for flagged user: ${email}`);
            await new Promise(resolve => setTimeout(resolve, 1500)); // Short server delay
            return res.status(200).json({ message: 'If the account exists, a reset code has been sent.' });
        }

        // 3. Check if Username matches
        if (user.username.toLowerCase() !== username.toLowerCase()) {
            let fails = (user.failed_credential_attempts || 0) + 1;
            
            if (fails >= 3) {
                // HONEYPOT ACTIVATED: Flag account, BAN IP, pretend it worked.
                await pool.query('UPDATE users SET is_flagged = true, failed_credential_attempts = $1 WHERE id = $2', [fails, user.id]);
                const ip = getClientIp(req);
                await pool.query('INSERT INTO ip_blacklist (ip_address, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ip, 'Credential Brute Force Honeypot']);
                
                console.warn(`[SECURITY] IP BANNED & Account flagged for brute force credentials: ${email} (${ip})`);
                return res.status(200).json({ message: 'If the account exists, a reset code has been sent.' });
            } else {
                // Normal failure
                await pool.query('UPDATE users SET failed_credential_attempts = $1 WHERE id = $2', [fails, user.id]);
                await new Promise(resolve => setTimeout(resolve, 500));
                return res.status(400).json({ message: 'Credentials do not match.' });
            }
        }

        // 4. Perfect Match: Reset tracking and generate OTP
        await pool.query('UPDATE users SET failed_credential_attempts = 0 WHERE id = $1', [user.id]);
        
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await pool.query(`UPDATE users SET otp = $1, otpexpiry = NOW() + INTERVAL '15 minutes' WHERE id = $2`, [otp, user.id]);

        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'noreply@xepic-labs.com',
            to: user.email,
            subject: 'Password Reset Request',
            html: `<p>Hi ${user.username},</p><p>We received a request to reset your password.</p><p>Your reset code is: <strong>${otp}</strong></p><p>This code expires in 15 minutes.</p>`
        });

        res.status(200).json({ message: 'If the account exists, a reset code has been sent.' });
    } catch (error) {
        console.error('[AUTH ERROR]', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// --- VERIFY OTP (STEP 1) WITH TARPITTING & AUTO-RESEND ---
app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;
        
        const userQuery = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (userQuery.rows.length === 0) {
            return res.status(400).json({ message: 'Invalid code' });
        }
        
        const user = userQuery.rows[0];

        // TARPIT: Flagged users get stuck in a short fake delay, then instructed to hang
        if (user.is_flagged) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            // Return special 423 code to trigger the infinite frontend hang
            return res.status(423).json({ message: 'tarpit' });
        }

        const isValid = user.otp === otp && new Date(user.otpexpiry) > new Date();

        if (isValid) {
            // Success! Reset security counters
            await pool.query('UPDATE users SET failed_otp_attempts = 0, otp_resends = 0 WHERE id = $1', [user.id]);
            return res.status(200).json({ message: 'Code verified successfully.' });
        } else {
            // Failure logic
            let fails = (user.failed_otp_attempts || 0) + 1;
            let resends = user.otp_resends || 0;

            if (fails >= 3) {
                resends += 1;
                if (resends >= 3) {
                    // MAX RESENDS HIT: Flag the account & BAN IP
                    await pool.query('UPDATE users SET is_flagged = true, failed_otp_attempts = $1, otp_resends = $2 WHERE id = $3', [fails, resends, user.id]);
                    const ip = getClientIp(req);
                    await pool.query('INSERT INTO ip_blacklist (ip_address, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ip, 'OTP Brute Force / Max Resends']);
                    
                    console.warn(`[SECURITY] IP BANNED & Account heavily flagged for brute force: ${email} (${ip})`);
                    return res.status(400).json({ message: 'Invalid code' });
                } else {
                    // AUTO-RESEND OTP
                    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
                    await pool.query(`UPDATE users SET otp = $1, otpexpiry = NOW() + INTERVAL '15 minutes', failed_otp_attempts = 0, otp_resends = $2 WHERE id = $3`, [newOtp, resends, user.id]);
                    
                    await resend.emails.send({
                        from: process.env.RESEND_FROM_EMAIL || 'noreply@xepic-labs.com',
                        to: user.email,
                        subject: 'New Password Reset Request',
                        html: `<p>Hi ${user.username},</p><p>We noticed multiple failed attempts. Here is a new reset code: <strong>${newOtp}</strong></p>`
                    });
                    
                    // Specific message frontend will catch
                    return res.status(422).json({ message: 'New code sent' });
                }
            } else {
                // Just increment fail count
                await pool.query('UPDATE users SET failed_otp_attempts = $1 WHERE id = $2', [fails, user.id]);
                return res.status(400).json({ message: 'Invalid code' });
            }
        }
    } catch (error) {
        console.error('[AUTH ERROR]', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ── RESET PASSWORD ────────────────────────────────────────────────────────────
app.post('/api/auth/reset-password', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;

        if (!email || !otp || !newPassword) {
            return res.status(400).json({ message: 'Email, OTP, and new password are required.' });
        }

        const checkUser = await pool.query(
            'SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND otp = $2 AND otpexpiry > NOW()',
            [email, otp]
        );

        if (checkUser.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid or expired reset code.' });
        }

        const user = checkUser.rows[0];
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        await pool.query(
            'UPDATE users SET password = $1, otp = NULL, otpexpiry = NULL WHERE id = $2',
            [hashedPassword, user.id]
        );

        console.log(`[AUTH] ✅ Password reset successful for: ${email}`);
        res.status(200).json({ message: 'Password updated successfully.' });

    } catch (error) {
        console.error('[AUTH ERROR] /reset-password:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ── CHANGE PASSWORD (Protected) ───────────────────────────────────────────────
app.post('/api/auth/change-password', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'No token provided.' });
        }
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET) as { id: string };

        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Current and new passwords are required.' });
        }

        const userQuery = await pool.query('SELECT password FROM users WHERE id = $1', [decoded.id]);
        if (userQuery.rows.length === 0) return res.status(404).json({ message: 'User not found.' });

        const validPassword = await bcrypt.compare(currentPassword, userQuery.rows[0].password);
        if (!validPassword) return res.status(401).json({ message: 'Incorrect current password.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, decoded.id]);

        console.log(`[AUTH] ✅ Password changed securely for user ID: ${decoded.id}`);
        res.status(200).json({ message: 'Password updated successfully.' });
    } catch (error: any) {
        console.error('[AUTH ERROR] /change-password:', error?.message || error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ── NOVA (AI COMMAND NODE) ────────────────────────────────────────────────────
app.post('/api/auth/chat', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'No token provided.' });
        }
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET) as { id: string; username: string; role: string };

        const { message, model, history } = req.body;
        if (!message) return res.status(400).json({ message: 'Message is required.' });

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ reply: 'Nova Core Offline: Missing GEMINI_API_KEY.' });
        }

        // ── RBAC Model Selection ──────────────────────────────────────────────
        let targetModel = 'gemini-2.5-flash';
        if (model === 'gemini-2.5-pro') {
            const roleQuery = await pool.query('SELECT role FROM users WHERE id = $1', [decoded.id]);
            if (roleQuery.rows.length > 0 && roleQuery.rows[0].role === 'admin') {
                targetModel = 'gemini-2.5-pro';
            }
        }

        // ── Build conversation contents with history ──────────────────────────
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

        // ── Inject live engine state into context ─────────────────────────────
        const [haltRes, configRes] = await Promise.all([
            pool.query(`SELECT halt_type FROM engine_halts WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1`),
            pool.query(`SELECT active_playbook, engine_state FROM engine_config LIMIT 1`),
        ]);
        const activeHalt    = haltRes.rows[0]?.halt_type ?? null;
        const engineState   = configRes.rows[0]?.engine_state ?? 'OFFLINE';
        const activePlaybook= configRes.rows[0]?.active_playbook ?? 'PROP_FIRM';

        const engineStateLabel: Record<string, string> = {
            OFFLINE:   '⚫ OFFLINE — not running',
            BOOTING:   '🟡 BOOTING — starting up, not yet hydrated',
            HYDRATING: '🔵 HYDRATING — loading historical market data, not yet ready',
            WARM_UP:   '🟠 WARM_UP — experts initializing, almost ready',
            HUNTING:   '🟢 HUNTING — fully operational, scanning for setups',
            HALTED:    `🔴 HALTED — entries blocked (${activeHalt ?? 'MANUAL_HALT'})`,
        };
        const stateDesc = engineStateLabel[engineState] ?? engineState;
        const liveContext = `

[LIVE ENGINE STATE — as of this message]
- Operational State: ${stateDesc}
- Active Playbook: ${activePlaybook}
- Halt Status: ${activeHalt ? `HALTED (${activeHalt})` : 'CLEAR — no active halts'}

IMPORTANT: Use this data to answer questions about the engine. Do NOT infer or guess the engine state from the conversation history. The above is ground truth pulled directly from the database.`;

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

You also have the ability to control the M.o.M trading engine. If the user tells you to stop trading, halt the engine, or close positions, you MUST execute the appropriate tool.
- Halt Trading: Halts new entries.
- Resume Trading: Clears all halts.
- Close Trade: Wipes the board and halts permanently.
- Switch Playbook: Switches the engine between PROP_FIRM (prop firm risk rules, buffer-based sizing) and CASH_ACCOUNT (standard buying power sizing). Use when the user says 'switch to prop firm', 'use prop firm playbook', 'switch to cash account', 'use cash account mode', etc.

The user's name is: ${decoded.username}${liveContext}`,
                tools: [{
                    functionDeclarations: [
                        {
                            name: "halt_engine",
                            description: "Halts the trading engine normally. The engine will not enter new trades, but will manage existing ones. Use this when the user says 'stop trading'.",
                            parameters: { type: "OBJECT" as any, properties: {} }
                        },
                        {
                            name: "resume_engine",
                            description: "Resumes the trading engine and clears all halts. Use this when the user says 'resume trading'.",
                            parameters: { type: "OBJECT" as any, properties: {} }
                        },
                        {
                            name: "close_engine",
                            description: "Emergency closes the trading engine. It immediately wipes the board (closes all open positions and orders) and halts permanently. Use this when the user says 'close the trade' or 'emergency stop'.",
                            parameters: { type: "OBJECT" as any, properties: {} }
                        },
                        {
                            name: "switch_playbook",
                            description: "Switches the M.o.M engine playbook between PROP_FIRM and CASH_ACCOUNT. PROP_FIRM uses buffer-based position sizing across active prop accounts. CASH_ACCOUNT uses standard buying power. Use when the user says 'switch to prop firm', 'use prop firm playbook', 'switch to cash account', 'use cash account mode', etc.",
                            parameters: {
                                type: "OBJECT" as any,
                                properties: {
                                    playbook: {
                                        type: "STRING" as any,
                                        enum: ["PROP_FIRM", "CASH_ACCOUNT"],
                                        description: "The playbook to activate."
                                    }
                                },
                                required: ["playbook"]
                            }
                        }
                    ]
                }]
            }
        });

        if (response.functionCalls && response.functionCalls.length > 0) {
            const call = response.functionCalls[0];
            let toolOutput = "";
            try {
                if (call.name === "halt_engine") {
                    await pool.query(`INSERT INTO engine_halts (halt_type, is_active) VALUES ('MANUAL_HALT', TRUE)`);
                    toolOutput = "Engine successfully halted.";
                } else if (call.name === "resume_engine") {
                    await pool.query(`UPDATE engine_halts SET is_active = FALSE WHERE is_active = TRUE`);
                    toolOutput = "Engine successfully resumed. All halts cleared.";
                } else if (call.name === "close_engine") {
                    await pool.query(`INSERT INTO engine_halts (halt_type, is_active) VALUES ('EMERGENCY_CLOSE', TRUE)`);
                    toolOutput = "Engine emergency closed. All positions will be flattened immediately.";
                } else if (call.name === "switch_playbook") {
                    const playbook = ((call.args as any)?.playbook ?? '').toUpperCase() as string;
                    if (!['PROP_FIRM', 'CASH_ACCOUNT'].includes(playbook)) {
                        toolOutput = "Invalid playbook value. Must be PROP_FIRM or CASH_ACCOUNT.";
                    } else {
                        await pool.query(
                            `UPDATE engine_config SET active_playbook = $1, updated_at = NOW() WHERE id = 1`,
                            [playbook]
                        );
                        await pool.query(
                            `INSERT INTO engine_notifications (event_type, message) VALUES ($1, $2)`,
                            ['PLAYBOOK_SWITCH', `🔄 Playbook → ${playbook} via Nova`]
                        );
                        // Build a contextual response with current buffer status
                        let bufInfo = '';
                        if (playbook === 'PROP_FIRM') {
                            const bufRes = await pool.query(
                                `SELECT account_balance, account_size, max_loss_limit FROM prop_accounts WHERE status = 'ACTIVE'`
                            );
                            if (bufRes.rows.length === 0) {
                                bufInfo = ' No active prop accounts found — entries will be blocked until an account is set to ACTIVE.';
                            } else {
                                const buffers = bufRes.rows.map((r: any) =>
                                    Number(r.max_loss_limit) + (Number(r.account_balance ?? r.account_size) - Number(r.account_size))
                                );
                                const minBuf = Math.min(...buffers);
                                const contracts = minBuf >= 1500
                                    ? `${Math.floor(minBuf / 1500)} ES`
                                    : `${Math.floor(minBuf / 150)} MES`;
                                bufInfo = ` Min buffer: $${minBuf.toFixed(0)} → sizing for ${contracts}.`;
                            }
                        }
                        toolOutput = `Playbook switched to ${playbook}.${bufInfo} The engine will pick up the change within 30 seconds.`;
                    }
                }
            } catch (err) {
                console.error("[NOVA TOOL ERROR]", err);
                toolOutput = "Failed to execute engine command due to database error.";
            }
            
            // Re-prompt model with tool output
            const followUp = await ai.models.generateContent({
                model: targetModel,
                contents: [
                    ...contents,
                    { role: 'model', parts: [{ functionCall: call }] },
                    { role: 'user', parts: [{ functionResponse: { name: call.name, response: { result: toolOutput } } }] }
                ]
            });
            return res.status(200).json({ reply: followUp.text });
        }

        res.status(200).json({ reply: response.text });
    } catch (error: any) {
        console.error('[NOVA ERROR]', error);
        res.status(500).json({ reply: 'Error communicating with Nova core.', message: error.message || String(error) });
    }
});

// ── PROP FIRM ACCOUNTS (Protected) ──────────────────────────────────────────
app.get('/api/auth/trading/prop-accounts', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try {
        jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
    } catch (jwtErr) {
        return res.status(401).json({ message: 'Token expired or invalid. Please log in again.' });
    }
    try {
        const result = await pool.query('SELECT * FROM prop_accounts ORDER BY created_at ASC');
        res.status(200).json(result.rows);
    } catch (error) {
        console.error('[API ERROR] /prop-accounts GET:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.patch('/api/auth/trading/risk', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'No token provided.' });
        }
        jwt.verify(authHeader.split(' ')[1], JWT_SECRET);

        const { risk_profile } = req.body;

        if (!['SAFE', 'AGGRESSIVE'].includes(risk_profile)) {
            return res.status(400).json({ message: 'Invalid risk profile.' });
        }

        // Update all prop accounts to use the same risk profile (global risk)
        await pool.query(
            'UPDATE prop_accounts SET risk_profile = $1',
            [risk_profile]
        );

        res.status(200).json({ message: 'Global risk updated', risk_profile });
    } catch (error) {
        console.error('[API ERROR] /trading/risk PATCH:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.post('/api/auth/trading/prop-accounts', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'No token provided.' });
        }
        jwt.verify(authHeader.split(' ')[1], JWT_SECRET);

        const { account_name, firm, phase, risk_profile, account_size } = req.body;

        if (!account_name || !firm || !phase || !risk_profile || !account_size) {
            return res.status(400).json({ message: 'All fields are required.' });
        }

        if (!['EVAL', 'FUNDED'].includes(phase) || !['SAFE', 'AGGRESSIVE'].includes(risk_profile)) {
            return res.status(400).json({ message: 'Invalid phase or risk profile enum.' });
        }

        // Fetch firm metrics
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

app.delete('/api/auth/trading/prop-accounts/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }
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

app.patch('/api/auth/trading/prop-accounts/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }
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

app.get('/api/auth/trading/engine/status', async (req, res) => {
    try {
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'No token provided.' });
        }
        try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
        catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }

        const haltResult = await pool.query(
            "SELECT halt_type FROM engine_halts WHERE is_active = TRUE ORDER BY created_at DESC LIMIT 1"
        );

        if (haltResult.rows.length > 0) {
            res.status(200).json({ status: 'HALTED', reason: haltResult.rows[0].halt_type, in_trade: false });
        } else {
            res.status(200).json({ status: 'ACTIVE', in_trade: false });
        }
    } catch (error) {
        console.error('[API ERROR] /engine/status GET:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ── ENGINE PLAYBOOK (Nova command) ───────────────────────────────────────────
app.patch('/api/auth/trading/engine/playbook', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }
    try {
        const { playbook } = req.body;
        if (!['PROP_FIRM', 'CASH_ACCOUNT'].includes(playbook)) {
            return res.status(400).json({ message: 'Invalid playbook. Use PROP_FIRM or CASH_ACCOUNT.' });
        }
        await pool.query(
            `UPDATE engine_config SET active_playbook = $1, updated_at = NOW()`,    
            [playbook]
        );
        // Push a notification so dashboard immediately reflects the switch
        await pool.query(
            `INSERT INTO engine_notifications (event_type, message) VALUES ($1, $2)`,
            ['PLAYBOOK_SWITCH', `🔄 Playbook → ${playbook} via Nova`]
        );
        console.log(`[API] ✅ Engine playbook switched to: ${playbook}`);
        res.status(200).json({ message: `Playbook switched to ${playbook}.`, playbook });
    } catch (error: any) {
        console.error('[API ERROR] /engine/playbook PATCH:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
app.get('/api/auth/trading/notifications', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }
    try {
        const page       = Math.max(1, parseInt(req.query.page  as string) || 1);
        const limit      = Math.min(50, parseInt(req.query.limit as string) || 20);
        const unreadOnly = req.query.unread_only === 'true';
        const offset     = (page - 1) * limit;
        const whereClause = unreadOnly ? 'WHERE read = FALSE' : '';

        const [rowsRes, countRes, unreadRes] = await Promise.all([
            pool.query(
                `SELECT id, event_type, message, read, created_at
                   FROM engine_notifications ${whereClause}
                  ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
                [limit, offset]
            ),
            pool.query(`SELECT COUNT(*) AS cnt FROM engine_notifications ${whereClause}`),
            pool.query(`SELECT COUNT(*) AS cnt FROM engine_notifications WHERE read = FALSE`),
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

app.patch('/api/auth/trading/notifications/read-all', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }
    try {
        await pool.query(`UPDATE engine_notifications SET read = TRUE WHERE read = FALSE`);
        res.status(200).json({ message: 'All notifications marked as read.' });
    } catch (error: any) {
        console.error('[API ERROR] /notifications/read-all PATCH:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ── Mark individual notification as read ───────────────────────────────────────
app.patch('/api/auth/trading/notifications/:id/read', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }
    try {
        const { id } = req.params;
        await pool.query(`UPDATE engine_notifications SET read = TRUE WHERE id = $1`, [id]);
        res.status(200).json({ message: 'Notification marked as read.' });
    } catch (error: any) {
        console.error('[API ERROR] /notifications/:id/read PATCH:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

app.get('/api/auth/trading/notifications/unread-count', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }
    try {
        const res2 = await pool.query(`SELECT COUNT(*) AS cnt FROM engine_notifications WHERE read = FALSE`);
        res.status(200).json({ unread: parseInt(res2.rows[0].cnt, 10) });
    } catch (error: any) {
        console.error('[API ERROR] /notifications/unread-count GET:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});


// ── DELETE notification (single) ──────────────────────────────────────────────
app.delete('/api/auth/trading/notifications/:id', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }
    try {
        const { id } = req.params;
        await pool.query(`DELETE FROM engine_notifications WHERE id = $1`, [id]);
        res.status(200).json({ message: 'Notification deleted.' });
    } catch (error: any) {
        console.error('[API ERROR] /notifications/:id DELETE:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ── DELETE all notifications ───────────────────────────────────────────────────
app.delete('/api/auth/trading/notifications', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'No token provided.' });
    }
    try { jwt.verify(authHeader.split(' ')[1], JWT_SECRET); }
    catch { return res.status(401).json({ message: 'Token expired or invalid.' }); }
    try {
        await pool.query(`DELETE FROM engine_notifications`);
        res.status(200).json({ message: 'All notifications cleared.' });
    } catch (error: any) {
        console.error('[API ERROR] /notifications DELETE:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

// ── SSE STREAM ENDPOINT ───────────────────────────────────────────────────────
// EventSource cannot set custom headers, so auth token is passed as ?token=
app.get('/api/auth/trading/notifications/stream', (req: any, res: any) => {
    const token = req.query.token as string | undefined;
    if (!token) return res.status(401).end();
    try { jwt.verify(token, JWT_SECRET); }
    catch { return res.status(401).end(); }

    // SSE headers
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');  // Disable Nginx / Cloudflare proxy buffering
    res.flushHeaders();

    // Confirm connection to client
    res.write(`event: connected\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);

    sseClients.add(res);
    console.log(`[SSE] Client connected (${sseClients.size} total)`);

    // 25s heartbeat — keeps connection alive through proxies that kill idle streams
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

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req: any, res: any) => {
    res.status(200).json({ status: 'Auth API Online', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════════════════════╗`);
    console.log(`║  🔐 xEpic Labs Auth Service                          ║`);
    console.log(`║  Running on port ${PORT}                                  ║`);
    console.log(`║  Neon DB: ${process.env.NEON_DATABASE_URL ? '✅ Connected' : '❌ MISSING URL'}                     ║`);
    console.log(`╚══════════════════════════════════════════════════════╝`);
    void startSsePoller();
});
