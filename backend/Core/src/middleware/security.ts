import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import pool from '../db';

const JWT_SECRET = process.env.JWT_SECRET!;

// --- HELPER TO EXTRACT CLIENT IP ---
export const getClientIp = (req: Request) => {
    const forwarded = req.headers['x-forwarded-for'];
    const ip = forwarded ? (typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0]) : req.socket.remoteAddress;
    return ip ? ip.trim() : 'unknown';
};

// --- GLOBAL IP BLACKLIST MIDDLEWARE ---
export const ipBlacklistMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    const ip = getClientIp(req);
    try {
        const banCheck = await pool.query('SELECT * FROM ip_blacklist WHERE ip_address = $1', [ip]);
        if (banCheck.rows.length > 0) {
            console.warn(`[SECURITY] Dropped connection from banned IP: ${ip}`);
            return res.status(403).send('Forbidden: Your IP address has been permanently flagged for malicious activity.');
        }
        next();
    } catch (err) {
        console.error('[DB ERROR] IP Check failed', err);
        next();
    }
};

// --- JWT AUTHENTICATION MIDDLEWARE ---
export const authenticateJWT = (req: any, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ message: 'Unauthorized' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const user = jwt.verify(token, JWT_SECRET);
        req.user = user;
        next();
    } catch (err) {
        return res.status(401).json({ message: 'Unauthorized: Invalid or expired token' });
    }
};
