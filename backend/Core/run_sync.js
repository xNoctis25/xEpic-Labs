require('ts-node').register();
require('dotenv').config();
const { syncFmpEvents } = require('./src/services/nycommand.ts');
syncFmpEvents().then(() => process.exit(0));
