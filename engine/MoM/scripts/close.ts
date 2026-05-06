import { NeonDatabase } from '../src/services/NeonDatabase';
import { HaltManager } from '../src/services/HaltManager';

async function run() {
    const db = new NeonDatabase();
    await db.initialize();
    
    const hm = new HaltManager(db);
    // EMERGENCY_CLOSE triggers a special DB poll event in the running engine
    // which flattens the broker and then permanently halts the engine.
    await hm.triggerHalt('EMERGENCY_CLOSE');
    
    console.log(`\n🚨 EMERGENCY CLOSE ENGAGED. The engine will instantly flatten all positions and permanently halt.`);
    process.exit(0);
}

run();
