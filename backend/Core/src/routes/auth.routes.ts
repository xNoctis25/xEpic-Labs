import express from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import pool from '../db';
import { Resend } from 'resend';
import { authenticateJWT, getClientIp } from '../middleware/security';

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET!;
const resend = new Resend(process.env.RESEND_API_KEY);

router.post('/signup', async (req, res) => {
    try {
        const { email, password, username } = req.body;
        if (!email || !password || !username) return res.status(400).json({ message: 'All fields are required.' });

        const userExists = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)', [email, username]);
        if (userExists.rows.length > 0) return res.status(400).json({ message: 'Username or email already exists.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const otp = Math.floor(100000 + Math.random() * 900000).toString();

        await pool.query(
            `INSERT INTO users (username, email, password, role, isverified, otp, otpexpiry) VALUES ($1, $2, $3, 'user', false, $4, NOW() + INTERVAL '15 minutes')`,
            [username, email, hashedPassword, otp]
        );

        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'noreply@xepic-labs.com',
            to: email,
            subject: 'Verify your xEpic Labs account',
            html: `<p>Welcome to xEpic Labs!</p><p>Your verification code is: <strong>${otp}</strong></p><p>This code will expire in 15 minutes.</p>`
        });

        console.log(`[AUTH] 📧 Verification OTP sent to: ${email}`);
        res.status(201).json({ message: 'User created. Please check your email for the verification code.' });
    } catch (error) {
        console.error('[AUTH ERROR] /signup:', error);
        res.status(500).json({ message: 'Internal server error during signup.' });
    }
});

router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ message: 'Username and password are required.' });

        const userQuery = await pool.query('SELECT * FROM users WHERE LOWER(username) = LOWER($1)', [username]);
        if (userQuery.rows.length === 0) return res.status(401).json({ message: 'Invalid username or password.' });

        const user = userQuery.rows[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ message: 'Invalid username or password.' });

        if (!user.isverified) return res.status(403).json({ requiresVerification: true, message: 'Account not verified. Please check your email.' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '30d' });

        console.log(`[AUTH] ✅ Login success: ${username}`);
        res.status(200).json({ token });
    } catch (error) {
        console.error('[AUTH ERROR] /login:', error);
        res.status(500).json({ message: 'Internal server error during login.' });
    }
});

router.get('/me', authenticateJWT, async (req: any, res: any) => {
    try {
        const userQuery = await pool.query(
            'SELECT id, username, email, isverified, role, createdat AS created_at FROM users WHERE id = $1',
            [req.user.id]
        );
        if (userQuery.rows.length === 0) return res.status(404).json({ message: 'User not found.' });
        res.status(200).json(userQuery.rows[0]);
    } catch (error) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.post('/logout', (_req, res) => {
    res.status(200).json({ message: 'Logged out successfully.' });
});

router.post('/check-exists', async (req, res) => {
    try {
        const { field, value } = req.body;
        if (field !== 'username' && field !== 'email') return res.status(400).json({ message: 'Invalid field parameter.' });
        const query = field === 'username' ? 'SELECT id FROM users WHERE LOWER(username) = LOWER($1)' : 'SELECT id FROM users WHERE LOWER(email) = LOWER($1)';
        const check = await pool.query(query, [value]);
        res.status(200).json({ exists: check.rows.length > 0 });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.post('/forgot-password', async (req, res) => {
    try {
        const { username, email } = req.body;
        const userQuery = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        
        if (userQuery.rows.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return res.status(400).json({ message: 'Credentials do not match.' });
        }
        const user = userQuery.rows[0];

        if (user.is_flagged) {
            console.warn(`[SECURITY] Honeypot triggered for flagged user: ${email}`);
            await new Promise(resolve => setTimeout(resolve, 1500));
            return res.status(200).json({ message: 'If the account exists, a reset code has been sent.' });
        }

        if (user.username.toLowerCase() !== username.toLowerCase()) {
            let fails = (user.failed_credential_attempts || 0) + 1;
            if (fails >= 3) {
                await pool.query('UPDATE users SET is_flagged = true, failed_credential_attempts = $1 WHERE id = $2', [fails, user.id]);
                const ip = getClientIp(req as any);
                await pool.query('INSERT INTO ip_blacklist (ip_address, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ip, 'Credential Brute Force Honeypot']);
                return res.status(200).json({ message: 'If the account exists, a reset code has been sent.' });
            } else {
                await pool.query('UPDATE users SET failed_credential_attempts = $1 WHERE id = $2', [fails, user.id]);
                await new Promise(resolve => setTimeout(resolve, 500));
                return res.status(400).json({ message: 'Credentials do not match.' });
            }
        }

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
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.post('/verify-otp', async (req, res) => {
    try {
        const { email, otp } = req.body;
        const userQuery = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (userQuery.rows.length === 0) return res.status(400).json({ message: 'Invalid code' });
        
        const user = userQuery.rows[0];

        if (user.is_flagged) {
            await new Promise(resolve => setTimeout(resolve, 2000));
            return res.status(423).json({ message: 'tarpit' });
        }

        const isValid = user.otp === otp && new Date(user.otpexpiry) > new Date();

        if (isValid) {
            await pool.query('UPDATE users SET failed_otp_attempts = 0, otp_resends = 0, isverified = true WHERE id = $1', [user.id]);
            return res.status(200).json({ message: 'Code verified successfully.' });
        } else {
            let fails = (user.failed_otp_attempts || 0) + 1;
            let resends = user.otp_resends || 0;

            if (fails >= 3) {
                resends += 1;
                if (resends >= 3) {
                    await pool.query('UPDATE users SET is_flagged = true, failed_otp_attempts = $1, otp_resends = $2 WHERE id = $3', [fails, resends, user.id]);
                    const ip = getClientIp(req as any);
                    await pool.query('INSERT INTO ip_blacklist (ip_address, reason) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ip, 'OTP Brute Force / Max Resends']);
                    return res.status(400).json({ message: 'Invalid code' });
                } else {
                    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
                    await pool.query(`UPDATE users SET otp = $1, otpexpiry = NOW() + INTERVAL '15 minutes', failed_otp_attempts = 0, otp_resends = $2 WHERE id = $3`, [newOtp, resends, user.id]);
                    
                    await resend.emails.send({
                        from: process.env.RESEND_FROM_EMAIL || 'noreply@xepic-labs.com',
                        to: user.email,
                        subject: 'New Password Reset Request',
                        html: `<p>Hi ${user.username},</p><p>We noticed multiple failed attempts. Here is a new reset code: <strong>${newOtp}</strong></p>`
                    });
                    
                    return res.status(422).json({ message: 'New code sent' });
                }
            } else {
                await pool.query('UPDATE users SET failed_otp_attempts = $1 WHERE id = $2', [fails, user.id]);
                return res.status(400).json({ message: 'Invalid code' });
            }
        }
    } catch (error) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.post('/resend-otp', async (req, res) => {
    try {
        const { email } = req.body;
        if (!email) return res.status(400).json({ message: 'Email is required.' });

        const userQuery = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
        if (userQuery.rows.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 500));
            return res.status(200).json({ message: 'If that account exists, a new code has been sent.' });
        }

        const user = userQuery.rows[0];

        if (user.isverified) return res.status(400).json({ message: 'Account is already verified.' });

        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await pool.query(`UPDATE users SET otp = $1, otpexpiry = NOW() + INTERVAL '15 minutes' WHERE id = $2`, [otp, user.id]);

        await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'noreply@xepic-labs.com',
            to: user.email,
            subject: 'Your new verification code',
            html: `<p>Your new verification code is: <strong>${otp}</strong></p><p>This code will expire in 15 minutes.</p>`
        });

        console.log(`[AUTH] 📧 Resent verification OTP to: ${user.email}`);
        res.status(200).json({ message: 'If that account exists, a new code has been sent.' });

    } catch (error) {
        console.error('[AUTH ERROR] /resend-otp:', error);
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.post('/reset-password', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword) return res.status(400).json({ message: 'Email, OTP, and new password are required.' });

        const checkUser = await pool.query('SELECT * FROM users WHERE LOWER(email) = LOWER($1) AND otp = $2 AND otpexpiry > NOW()', [email, otp]);
        if (checkUser.rows.length === 0) return res.status(401).json({ message: 'Invalid or expired reset code.' });

        const user = checkUser.rows[0];
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        await pool.query('UPDATE users SET password = $1, otp = NULL, otpexpiry = NULL WHERE id = $2', [hashedPassword, user.id]);
        res.status(200).json({ message: 'Password updated successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

router.post('/change-password', authenticateJWT, async (req: any, res: any) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Current and new passwords are required.' });

        const userQuery = await pool.query('SELECT password FROM users WHERE id = $1', [req.user.id]);
        if (userQuery.rows.length === 0) return res.status(404).json({ message: 'User not found.' });

        const validPassword = await bcrypt.compare(currentPassword, userQuery.rows[0].password);
        if (!validPassword) return res.status(401).json({ message: 'Incorrect current password.' });

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hashedPassword, req.user.id]);
        res.status(200).json({ message: 'Password updated successfully.' });
    } catch (error) {
        res.status(500).json({ message: 'Internal server error.' });
    }
});

export default router;
