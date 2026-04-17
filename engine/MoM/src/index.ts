import * as dotenv from 'dotenv';
import { TradovateBroker } from './brokers/TradovateBroker';
import { MoMEngine } from './core/MoMEngine';
import { config } from './config/env';

dotenv.config();

console.log("==========================================");
console.log("  M.o.M (Master of Master) Quant Engine   ");
console.log("  Version 2.0 - Triple Threat Architecture ");
console.log(`  DOM Expert: ${config.USE_DOM_EXPERT ? '🟢 ENABLED' : '🔴 DISABLED'}`);
console.log("==========================================\n");

// 1. Initialize the Broker (LIVE endpoint)
const broker = new TradovateBroker();

// 2. Inject Broker into the Engine
const engine = new MoMEngine(broker);

// 3. Ignite the system
engine.start().catch(err => {
    console.error("🔴 [SYSTEM FATAL] - Engine failed to start: ", err);
});
