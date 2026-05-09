require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.NEON_DATABASE_URL });
pool.query('SELECT column_name, data_type FROM information_schema.columns WHERE table_name = \'economic_events\';')
  .then(res => console.log(res.rows))
  .catch(e => console.log('ERROR:', e.message))
  .then(() => process.exit(0));
