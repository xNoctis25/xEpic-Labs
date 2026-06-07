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
const dotenv = __importStar(require("dotenv"));
dotenv.config();
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const db_1 = __importDefault(require("./db"));
// Middleware & Security
const security_1 = require("./middleware/security");
// Routes
const auth_routes_1 = __importDefault(require("./routes/auth.routes"));
const trading_routes_1 = __importDefault(require("./routes/trading.routes"));
const nova_routes_1 = __importDefault(require("./routes/nova.routes"));
// Services
const nycommand_1 = require("./services/nycommand");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Apply global IP blacklisting
app.use(security_1.ipBlacklistMiddleware);
// ── MOUNT ROUTERS ────────────────────────────────────────────────────────────
// Note: Frontend API_BASE is `/api/auth`, so we preserve the URL namespace
// but the code is now securely decoupled into Modular Monolith sub-routers.
app.use('/api/auth', auth_routes_1.default);
app.use('/api/auth', nova_routes_1.default);
app.use('/api/auth/trading', trading_routes_1.default);
// ── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.status(200).json({ status: 'Core API Online', timestamp: new Date().toISOString() });
});
// ── DYNAMIC SECURITY MIGRATION (UUID) ─────────────────────────────────────────
db_1.default.query(`
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

    DROP TABLE IF EXISTS prop_firm_metrics CASCADE;
    DROP TABLE IF EXISTS prop_accounts CASCADE;

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
        user_id      INTEGER,
        title VARCHAR(255) NOT NULL,
        event_date TIMESTAMPTZ NOT NULL,
        event_type VARCHAR(50) NOT NULL,
        amount       NUMERIC(12,2),
        account_id   UUID,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS financial_accounts (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      INTEGER NOT NULL,
        account_name VARCHAR(255) NOT NULL,
        account_type VARCHAR(50)  NOT NULL,
        created_at   TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, account_name, account_type)
    );

    -- Backfill: add columns to existing custom_events if table already existed
    ALTER TABLE custom_events
        ADD COLUMN IF NOT EXISTS user_id     INTEGER,
        ADD COLUMN IF NOT EXISTS amount      NUMERIC(12,2),
        ADD COLUMN IF NOT EXISTS account_id  UUID;

    -- FK: account_id -> financial_accounts (add only if not already present)
    DO $$
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints
            WHERE constraint_name = 'custom_events_account_id_fkey'
        ) THEN
            ALTER TABLE custom_events
                ADD CONSTRAINT custom_events_account_id_fkey
                FOREIGN KEY (account_id)
                REFERENCES financial_accounts(id)
                ON DELETE SET NULL;
        END IF;
    END $$;

    CREATE OR REPLACE FUNCTION notify_new_notification()
    RETURNS trigger AS $$
    BEGIN
        PERFORM pg_notify('new_notification', '1');
        RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;

    DROP TRIGGER IF EXISTS trg_new_notification ON notifications;
    CREATE TRIGGER trg_new_notification
    AFTER INSERT ON notifications
    FOR EACH ROW EXECUTE FUNCTION notify_new_notification();
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
    void (0, nycommand_1.startSsePoller)();
    (0, nycommand_1.startEarlyCloseEngine)();
});
