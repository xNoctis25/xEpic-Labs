require('dotenv').config({path: '.env'});
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL, ssl: true });
pool.query("INSERT INTO notifications (event_type, message) VALUES ('market_alert', 'TEST')").then(res => { console.log('Insert success'); pool.end(); }).catch(console.error);
