const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const ip = process.argv[2];

async function unban() {
    try {
        if (ip) {
            const res = await pool.query('DELETE FROM ip_blacklist WHERE ip_address = $1', [ip]);
            console.log(res.rowCount > 0 ? `✅ Successfully unbanned IP: ${ip}` : `⚠️ IP not found in blacklist: ${ip}`);
        } else {
            console.log('No IP provided. Skipping IP unban. (Usage: node unban.js <IP>)');
        }
        
        // Wipe ALL user security flags so testing can resume
        const res2 = await pool.query('UPDATE users SET is_flagged = false, failed_credential_attempts = 0, failed_otp_attempts = 0, otp_resends = 0 WHERE is_flagged = true');
        console.log(`✅ Cleared security flags from ${res2.rowCount} user accounts.`);
    } catch (err) {
        console.error('Error:', err);
    } finally {
        pool.end();
        process.exit(0);
    }
}
unban();
