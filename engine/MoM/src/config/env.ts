import * as dotenv from 'dotenv';
import type { RiskProfile } from '../core/PositionSizer';
dotenv.config();

export const config = {
    TRADING_MODE: process.env.TRADING_MODE || 'PAPER',
    USE_DOM_EXPERT: process.env.USE_DOM_EXPERT === 'true',
    VERBOSE_SMC_LOGGING: process.env.VERBOSE_SMC_LOGGING === 'true',
    SYMBOL_ROOT: process.env.SYMBOL_ROOT || 'MES',
    RISK_PROFILE: (process.env.RISK_PROFILE || 'MODEST') as RiskProfile,

    // Tradovate Credentials (Universal — same for Demo and Live)
    TRADOVATE_USERNAME: process.env.TRADOVATE_USERNAME || '',
    TRADOVATE_PASSWORD: process.env.TRADOVATE_PASSWORD || '',
    TRADOVATE_APP_ID: process.env.TRADOVATE_APP_ID || '',
    TRADOVATE_APP_VERSION: process.env.TRADOVATE_APP_VERSION || '',
    TRADOVATE_CLIENT_ID: process.env.TRADOVATE_CLIENT_ID || '',
    TRADOVATE_CLIENT_SECRET: process.env.TRADOVATE_CLIENT_SECRET || '',

    ORACLE_API_KEY: process.env.ORACLE_API_KEY || '',
};
