import { NeonDatabase } from '../src/services/NeonDatabase';
import { HaltManager } from '../src/services/HaltManager';

async function run() {
    const db = new NeonDatabase();
    await db.initialize();
    
    const hm = new HaltManager(db);
    await hm.triggerHalt('MANUAL_HALT');
    
    console.log(`\n🛑 MANUAL HALT ENGAGED. The engine will not take any trades until unhalted.`);
    process.exit(0);
}

run();
