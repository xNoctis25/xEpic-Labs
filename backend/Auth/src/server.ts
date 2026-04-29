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

// --- DYNAMIC SECURITY MIGRATION ---
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
`).catch(err => console.error('[DB] Note: Security column migration skipped or already exists.'));

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
        const decoded = jwt.verify(token, JWT_SECRET) as { id: number; username: string; role: string };

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

// ── N.O.V.A. (AI COMMAND NODE) ────────────────────────────────────────────────
app.post('/api/auth/chat', async (req, res) => {
    try {
        // Protect the route using the existing JWT logic
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({ message: 'No token provided.' });
        }
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET) as { id: number; username: string; role: string };

        const { message, model } = req.body;
        if (!message) return res.status(400).json({ message: 'Message is required.' });

        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ reply: 'N.O.V.A. Core Offline: Missing GEMINI_API_KEY.', message: 'N.O.V.A. Core Offline: Missing GEMINI_API_KEY.' });
        }

        // ── RBAC Model Selection ──────────────────────────────────────────────
        // Default to flash for all users. Pro requires admin role, verified server-side.
        let targetModel = 'gemini-2.5-flash';
        if (model === 'gemini-2.5-pro') {
            const roleQuery = await pool.query('SELECT role FROM users WHERE id = $1', [decoded.id]);
            if (roleQuery.rows.length > 0 && roleQuery.rows[0].role === 'admin') {
                targetModel = 'gemini-2.5-pro';
            }
        }

        const ai = new GoogleGenAI({ apiKey: apiKey });
        const response = await ai.models.generateContent({
            model: targetModel,
            contents: message,
            config: {
                systemInstruction: "You are N.O.V.A. AI for xEpic Labs. Keep your responses simple, clean, and concise. Do not output server times or verbose data. If asked for a greeting, reply exactly with: 'Greetings, How may I assist you?'"
            }
        });

        res.status(200).json({ reply: response.text });
    } catch (error: any) {
        console.error('[NOVA ERROR]', error);
        res.status(500).json({ reply: 'Error communicating with N.O.V.A. core.', message: 'Error communicating with N.O.V.A. core.' });
    }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'Auth API Online', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════════════════════╗`);
    console.log(`║  🔐 xEpic Labs Auth Service                          ║`);
    console.log(`║  Running on port ${PORT}                                  ║`);
    console.log(`║  Neon DB: ${process.env.NEON_DATABASE_URL ? '✅ Connected' : '❌ MISSING URL'}                     ║`);
    console.log(`╚══════════════════════════════════════════════════════╝`);
});
