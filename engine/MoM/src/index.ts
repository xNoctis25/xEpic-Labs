import * as dotenv from 'dotenv';
import { TradovateBroker } from './brokers/TradovateBroker';
import { MoMEngine } from './core/MoMEngine';

dotenv.config();

console.log("==========================================");
console.log("  M.o.M (Master of Master) Quant Engine   ");
console.log("  Version 1.0 - Level 1 Top-of-Book Base  ");
console.log("==========================================\n");

// 1. Initialize the Broker
const broker = new TradovateBroker();

// 2. Inject Broker into the Engine
const engine = new MoMEngine(broker);

// 3. Ignite the system
engine.start().catch(err => {
    console.error("🔴 [SYSTEM FATAL] - Engine failed to start: ", err);
});
