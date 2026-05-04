const { Client } = require('pg');
const c = new Client('postgresql://neondb_owner:npg_1m8eXnbayqho@ep-lively-snow-amzdq1du-pooler.c-5.us-east-1.aws.neon.tech/neondb?sslmode=require');

c.connect().then(async () => {
  const telem = await c.query("SELECT * FROM mom_telemetry_logs ORDER BY timestamp DESC LIMIT 20");
  console.log('\n=== TELEMETRY (last 20) ===');
  telem.rows.forEach(t => console.log(`${new Date(t.timestamp).toLocaleString('en-US', {timeZone:'America/New_York'})} | ${t.source} | ${t.regime} | ${t.message}`));

  // Check all tables
  const tables = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'");
  console.log('\n=== TABLES ===');
  tables.rows.forEach(t => console.log(t.table_name));
  
  c.end();
}).catch(e => { console.error(e.message); c.end(); });
