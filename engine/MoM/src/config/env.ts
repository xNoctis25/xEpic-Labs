import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
    TRADING_MODE: process.env.TRADING_MODE || 'PAPER',
    USE_ORACLE: process.env.USE_ORACLE === 'true',
    VERBOSE_SMC_LOGGING: process.env.VERBOSE_SMC_LOGGING === 'true',
    INDICES: process.env.INDICES || 'MES',
    RISK: parseInt(process.env.RISK || '2', 10),
    BACKTEST_CAPITAL: parseInt(process.env.BACKTEST_CAPITAL || '50000', 10),

    // Tradovate Credentials (Universal — same for Demo and Live)
    TRADOVATE_USERNAME: process.env.TRADOVATE_USERNAME || '',
    TRADOVATE_PASSWORD: process.env.TRADOVATE_PASSWORD || '',
    TRADOVATE_APP_ID: process.env.TRADOVATE_APP_ID || '',
    TRADOVATE_APP_VERSION: process.env.TRADOVATE_APP_VERSION || '',
    TRADOVATE_CLIENT_ID: process.env.TRADOVATE_CLIENT_ID || '',
    TRADOVATE_CLIENT_SECRET: process.env.TRADOVATE_CLIENT_SECRET || '',

    ORACLE_API_KEY: process.env.ORACLE_API_KEY || '',

    // Prop Firm Safety Ceiling (0 = uncapped / dynamic)
    MAX_CONTRACTS: process.env.MAX_CONTRACTS ? parseInt(process.env.MAX_CONTRACTS, 10) : 0,
};
