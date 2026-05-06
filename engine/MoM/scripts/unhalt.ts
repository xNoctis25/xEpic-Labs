import { NeonDatabase } from '../src/services/NeonDatabase';
import { HaltManager } from '../src/services/HaltManager';

async function run() {
    const db = new NeonDatabase();
    await db.initialize();
    
    const hm = new HaltManager(db);
    await hm.initialize();
    await hm.resolveHalt();
    
    console.log(`\n🟢 HALT RESOLVED. The engine is now live and will take trades.`);
    process.exit(0);
}

run();
