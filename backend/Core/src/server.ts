import express from 'express';
import cors from 'cors';
import * as dotenv from 'dotenv';
import pool from './db';

// Middleware & Security
import { ipBlacklistMiddleware } from './middleware/security';

// Routes
import authRoutes from './routes/auth.routes';
import propRoutes from './routes/prop.routes';
import tradingRoutes from './routes/trading.routes';
import novaRoutes from './routes/nova.routes';

// Services
import { startSsePoller, syncFmpEvents, startFmpTickEngine, startEarlyCloseEngine } from './services/nycommand';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Apply global IP blacklisting
app.use(ipBlacklistMiddleware);

// ── MOUNT ROUTERS ────────────────────────────────────────────────────────────
// Note: Frontend API_BASE is `/api/auth`, so we preserve the URL namespace
// but the code is now securely decoupled into Modular Monolith sub-routers.
app.use('/api/auth', authRoutes);
app.use('/api/auth', novaRoutes);
app.use('/api/auth/trading/prop-accounts', propRoutes);
app.use('/api/auth/trading', tradingRoutes);

// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req: any, res: any) => {
    res.status(200).json({ status: 'Core API Online', timestamp: new Date().toISOString() });
});

// ── DYNAMIC SECURITY MIGRATION (UUID) ─────────────────────────────────────────
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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(firm_name, account_size)
    );

    CREATE TABLE IF NOT EXISTS prop_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_name VARCHAR(255) NOT NULL,
        firm VARCHAR(50) NOT NULL,
        phase VARCHAR(20) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
        risk_profile VARCHAR(20) NOT NULL,
        account_size NUMERIC(10,2) NOT NULL,
        profit_target NUMERIC(10,2) NOT NULL,
        max_loss_limit NUMERIC(10,2) NOT NULL,
        max_position_size INT NOT NULL,
        current_pnl NUMERIC(10,2) DEFAULT 0,
        account_balance NUMERIC(10,2),
        best_day_pnl NUMERIC(10,2) DEFAULT 0,
        days_traded INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        event_type VARCHAR(50) NOT NULL,
        message TEXT NOT NULL,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS economic_events (
        id VARCHAR(255) PRIMARY KEY,
        event_name VARCHAR(255) NOT NULL,
        event_date TIMESTAMPTZ NOT NULL,
        impact VARCHAR(20) NOT NULL,
        country VARCHAR(10) NOT NULL,
        actual NUMERIC,
        estimate NUMERIC,
        previous NUMERIC,
        blackout_start TIMESTAMP WITH TIME ZONE,
        blackout_end TIMESTAMP WITH TIME ZONE,
        is_archived BOOLEAN DEFAULT FALSE,
        notified_start BOOLEAN DEFAULT FALSE,
        notified_end BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS custom_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title VARCHAR(255) NOT NULL,
        event_date TIMESTAMPTZ NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO prop_firm_metrics (firm_name, account_size, profit_target, max_loss_limit, max_position_size)
    VALUES 
        ('Topstep', 50000, 3000, 2000, 5),
        ('Topstep', 100000, 6000, 3000, 10),
        ('Topstep', 150000, 9000, 4500, 15),
        ('Apex', 50000, 3000, 2500, 10),
        ('Apex', 250000, 15000, 6500, 35)
    ON CONFLICT (firm_name, account_size) DO NOTHING;
`).then(() => console.log('[DB] Schema migrations verified.'))
  .catch((e) => console.error('[DB ERROR] Schema migration failed:', e));

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`╔══════════════════════════════════════════════════════╗`);
    console.log(`║  🚀 xEpic Labs Core Service (Modular Monolith)       ║`);
    console.log(`║  Running on port ${PORT}                                  ║`);
    console.log(`║  Neon DB: ${process.env.NEON_DATABASE_URL ? '✅ Connected' : '❌ MISSING URL'}                     ║`);
    console.log(`╚══════════════════════════════════════════════════════╝`);
    
    // Boot NYCommand Background Engines
    void startSsePoller();
    void syncFmpEvents();
    startFmpTickEngine();
    startEarlyCloseEngine();
});
