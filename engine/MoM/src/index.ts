import * as dotenv from 'dotenv';
import { MoMEngine } from './core/MoMEngine';
import { config } from './config/env';

dotenv.config();

console.log("==========================================");
console.log("  M.o.M (Master of Master) Quant Engine   ");
console.log("  Version 2.0 - Triple Threat Architecture ");
console.log(`  DOM Expert: ${config.USE_DOM_EXPERT ? '🟢 ENABLED' : '🔴 DISABLED'}`);
console.log("==========================================\n");

// Engine creates its own broker after determining phase (DEMO vs LIVE)
const engine = new MoMEngine();

engine.start().catch(err => {
    console.error("🔴 [SYSTEM FATAL] - Engine failed to start: ", err);
});
