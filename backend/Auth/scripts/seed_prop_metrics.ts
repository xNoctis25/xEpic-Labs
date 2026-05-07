import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.join(__dirname, '../.env') });

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function run() {
    try {
        console.log('[SEED] Creating prop_firm_metrics table...');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS prop_firm_metrics (
                id SERIAL PRIMARY KEY,
                firm_name VARCHAR(50) NOT NULL,
                account_size NUMERIC(10,2) NOT NULL,
                profit_target NUMERIC(10,2) NOT NULL,
                max_loss_limit NUMERIC(10,2) NOT NULL,
                max_position_size INT NOT NULL,
                UNIQUE(firm_name, account_size)
            );
        `);

        console.log('[SEED] Inserting Topstep tier configurations...');
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

        console.log('[SEED] Altering prop_accounts to include new constraints...');
        await pool.query(`
            ALTER TABLE prop_accounts 
            ADD COLUMN IF NOT EXISTS account_size NUMERIC(10,2) DEFAULT 0,
            ADD COLUMN IF NOT EXISTS max_loss_limit NUMERIC(10,2) DEFAULT 0,
            ADD COLUMN IF NOT EXISTS max_position_size INT DEFAULT 0;
        `);

        console.log('[SEED] Database migration and seeding complete! ✅');
    } catch (err) {
        console.error('[SEED ERROR]', err);
    } finally {
        await pool.end();
    }
}

run();
