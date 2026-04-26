"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const bcrypt_1 = __importDefault(require("bcrypt"));
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const db_1 = __importDefault(require("./db"));
const resend_1 = require("resend");
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';
const resend = new resend_1.Resend(process.env.RESEND_API_KEY);
// ── SIGN UP ──────────────────────────────────────────────────────────────────
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        if (!username || !email || !password) {
            return res.status(400).json({ message: 'Username, email, and password are required.' });
        }
        // 1. Check for duplicates
        const checkUser = await db_1.default.query('SELECT id FROM users WHERE username = $1 OR email = $2', [username, email]);
        if (checkUser.rows.length > 0) {
            return res.status(409).json({ message: 'Username or Email already exists.' });
        }
        // 2. Hash password & generate OTP
        const salt = await bcrypt_1.default.genSalt(10);
        const hashedPassword = await bcrypt_1.default.hash(password, salt);
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        // 3. Insert user row
        await db_1.default.query(`INSERT INTO users (username, email, password, isverified, otp, otpexpiry, role)
             VALUES ($1, $2, $3, false, $4, NOW() + INTERVAL '15 minutes', 'user')`, [username, email, hashedPassword, otp]);
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
    }
    catch (error) {
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
        const checkUser = await db_1.default.query('SELECT * FROM users WHERE username = $1 AND otp = $2 AND otpexpiry > NOW()', [username, otp]);
        if (checkUser.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid or expired OTP.' });
        }
        const user = checkUser.rows[0];
        // Mark verified and clear OTP fields
        await db_1.default.query('UPDATE users SET isverified = true, otp = NULL, otpexpiry = NULL WHERE id = $1', [user.id]);
        const token = jsonwebtoken_1.default.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        console.log(`[AUTH] ✅ User verified: ${username}`);
        res.status(200).json({ token });
    }
    catch (error) {
        console.error('[AUTH ERROR] /verify:', error);
        res.status(500).json({ message: 'Internal server error during verification.' });
    }
});
// ── RESEND OTP ───────────────────────────────────────────────────────────────
app.post('/api/auth/resend-otp', async (req, res) => {
    try {
        const { username } = req.body;
        const userQuery = await db_1.default.query('SELECT * FROM users WHERE username = $1 AND isverified = false', [username]);
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ message: 'User not found or already verified.' });
        }
        const user = userQuery.rows[0];
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await db_1.default.query("UPDATE users SET otp = $1, otpexpiry = NOW() + INTERVAL '15 minutes' WHERE id = $2", [otp, user.id]);
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
    }
    catch (error) {
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
        const userQuery = await db_1.default.query('SELECT * FROM users WHERE username = $1', [username]);
        if (userQuery.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }
        const user = userQuery.rows[0];
        const validPassword = await bcrypt_1.default.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ message: 'Invalid username or password.' });
        }
        if (!user.isverified) {
            return res.status(403).json({ requiresVerification: true, message: 'Account not verified. Please check your email.' });
        }
        const token = jsonwebtoken_1.default.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        console.log(`[AUTH] ✅ Login success: ${username}`);
        res.status(200).json({ token });
    }
    catch (error) {
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
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const userQuery = await db_1.default.query('SELECT id, username, email, role, created_at FROM users WHERE id = $1', [decoded.id]);
        if (userQuery.rows.length === 0) {
            return res.status(404).json({ message: 'User not found.' });
        }
        res.status(200).json(userQuery.rows[0]);
    }
    catch (error) {
        res.status(401).json({ message: 'Invalid or expired token.' });
    }
});
// ── LOGOUT ────────────────────────────────────────────────────────────────────
app.post('/api/auth/logout', (_req, res) => {
    // JWT is stateless — client clears the token
    res.status(200).json({ message: 'Logged out successfully.' });
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
