const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const pool = new Pool({ connectionString: 'postgresql://neondb_owner:npg_1m8eXnbayqho@ep-lively-snow-amzdq1du-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require' });
async function run() { 
    const pw = await bcrypt.hash('password123', 10); 
    await pool.query("INSERT INTO users (username, email, password, isverified, role) VALUES ('testuser', 'test@test.com', $1, 1, 'user') ON CONFLICT DO NOTHING", [pw]); 
    await pool.query("UPDATE users SET password=$1, isverified=1 WHERE username='testuser'", [pw]); 
    console.log('Test user ready'); 
    process.exit(0); 
} 
run();
