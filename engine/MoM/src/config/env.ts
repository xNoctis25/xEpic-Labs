import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
    TRADING_MODE: process.env.TRADING_MODE || 'PAPER',
    USE_DOM_EXPERT: process.env.USE_DOM_EXPERT === 'true',

    // Shared Tradovate App Identity
    TRADOVATE_APP_ID: process.env.TRADOVATE_APP_ID || '',
    TRADOVATE_APP_VERSION: process.env.TRADOVATE_APP_VERSION || '',

    // Demo Credentials (Prop Firm / Evaluation)
    TRADOVATE_DEMO_USERNAME: process.env.TRADOVATE_DEMO_USERNAME || '',
    TRADOVATE_DEMO_PASSWORD: process.env.TRADOVATE_DEMO_PASSWORD || '',
    TRADOVATE_DEMO_CLIENT_ID: process.env.TRADOVATE_DEMO_CLIENT_ID || '',
    TRADOVATE_DEMO_CLIENT_SECRET: process.env.TRADOVATE_DEMO_CLIENT_SECRET || '',

    // Live Credentials (Personal / Market Data + Level 2)
    TRADOVATE_LIVE_USERNAME: process.env.TRADOVATE_LIVE_USERNAME || '',
    TRADOVATE_LIVE_PASSWORD: process.env.TRADOVATE_LIVE_PASSWORD || '',
    TRADOVATE_LIVE_CLIENT_ID: process.env.TRADOVATE_LIVE_CLIENT_ID || '',
    TRADOVATE_LIVE_CLIENT_SECRET: process.env.TRADOVATE_LIVE_CLIENT_SECRET || '',

    ORACLE_API_KEY: process.env.ORACLE_API_KEY || '',
    DAILY_LOSS_LIMIT: -200.00
};
