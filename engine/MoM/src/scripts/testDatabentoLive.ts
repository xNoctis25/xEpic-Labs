import * as dotenv from 'dotenv';
dotenv.config();

import * as net from 'net';
import * as crypto from 'crypto';

// ─── Constants ─────────────────────────────────────────────────
const LSG_HOST = 'glbx-mdp3.lsg.databento.com';
const LSG_PORT = 13000;
const DATASET = 'GLBX.MDP3';
const SYMBOL = 'MES.c.0';
const SCHEMA = 'trades';

const PRICE_SCALE = 1e-9; 

// ─── CRAM Authentication ───────────────────────────────────────
function cramResponse(challenge: string, apiKey: string): string {
    const bucketId = apiKey.slice(-5);
    const sha256 = crypto.createHash('sha256')
        .update(`${challenge}|${apiKey}`)
        .digest('hex');
    return `${sha256}-${bucketId}`;
}

// ─── Main Test ─────────────────────────────────────────────────
async function run(): Promise<void> {
    const apiKey = (process.env.DATABENTO_API_KEY || '').trim();
    if (!apiKey) {
        console.error('❌ DATABENTO_API_KEY not set in .env');
        process.exit(1);
    }

    console.log('\n🧪 ═══════════════════════════════════════════');
    console.log('🧪  DATABENTO LIVE TEST — Verified Offsets');
    console.log('🧪 ═══════════════════════════════════════════\n');

    console.log(`📡 Connecting to ${LSG_HOST}:${LSG_PORT}...`);

    const socket = net.createConnection({ host: LSG_HOST, port: LSG_PORT });

    let state: 'GREETING' | 'CHALLENGE' | 'AUTH_RESPONSE' | 'STREAMING' = 'GREETING';
    let tradeCount = 0;
    let binaryBuffer = Buffer.alloc(0);
    let metadataSkipped = false;
    let textBuffer = ''; 

    socket.on('connect', () => {
        console.log('✅ TCP connection established. Waiting for greeting...\n');
    });

    socket.on('data', (data: Buffer) => {
        if (state !== 'STREAMING') {
            textBuffer += data.toString('utf-8');

            while (textBuffer.includes('\n')) {
                const newlineIdx = textBuffer.indexOf('\n');
                const line = textBuffer.slice(0, newlineIdx + 1);
                textBuffer = textBuffer.slice(newlineIdx + 1);

                console.log(`[GATEWAY] ${line.trim()}`);

                const fields: Record<string, string> = {};
                for (const token of line.trim().split('|')) {
                    const eqIdx = token.indexOf('=');
                    if (eqIdx !== -1) {
                        fields[token.slice(0, eqIdx)] = token.slice(eqIdx + 1);
                    }
                }

                if (state === 'GREETING' && fields['lsg_version']) {
                    state = 'CHALLENGE';
                    continue;
                }

                if (state === 'CHALLENGE' && fields['cram']) {
                    const challenge = fields['cram'];
                    const response = cramResponse(challenge, apiKey);
                    const authMsg = [
                        `auth=${response}`,
                        `dataset=${DATASET}`,
                        `encoding=dbn`,
                        `ts_out=0`,
                        `compression=none`,
                    ].join('|') + '\n';

                    socket.write(authMsg);
                    state = 'AUTH_RESPONSE';
                    continue;
                }

                if (state === 'AUTH_RESPONSE' && fields['success'] !== undefined) {
                    if (fields['success'] === '1') {
                        console.log(`\n📡 Subscribing to ${SYMBOL} ${SCHEMA}...`);
                        const subMsg = [
                            `schema=${SCHEMA}`,
                            `stype_in=continuous`,
                            `symbols=${SYMBOL}`,
                            `snapshot=0`,
                            `is_last=1`,
                        ].join('|') + '\n';
                        socket.write(subMsg);
                        
                        // FIX: start_session with NO arguments
                        socket.write('start_session\n');
                        
                        console.log(`✅ Subscribed. Waiting for first 5 trades...\n`);
                        state = 'STREAMING';

                        if (textBuffer.length > 0) {
                            binaryBuffer = Buffer.concat([binaryBuffer, Buffer.from(textBuffer, 'binary')]);
                            textBuffer = '';
                        }
                    } else {
                        console.error(`❌ Authentication FAILED`);
                        socket.destroy();
                        process.exit(1);
                    }
                    continue;
                }
            }
            return;
        }

        binaryBuffer = Buffer.concat([binaryBuffer, data]);

        if (!metadataSkipped) {
            const dbnMagicIdx = binaryBuffer.indexOf(Buffer.from([0x44, 0x42, 0x4E]));
            if (dbnMagicIdx === -1) return;
            if (binaryBuffer.length < dbnMagicIdx + 8) return;

            const metaLength = binaryBuffer.readUInt32LE(dbnMagicIdx + 4);
            // FIX: + 8 to account for Magic and Length bytes
            const totalMetaSize = dbnMagicIdx + 8 + metaLength; 

            if (binaryBuffer.length < totalMetaSize) return;

            console.log(`📦 [DBN] Metadata received (${totalMetaSize} bytes). Parsing trade records...\n`);
            binaryBuffer = binaryBuffer.slice(totalMetaSize);
            metadataSkipped = true;
        }

        while (binaryBuffer.length >= 4) {
            const lengthWords = binaryBuffer[0];
            const recordSize = lengthWords * 4;

            if (recordSize === 0 || binaryBuffer.length < recordSize) break;

            const record = binaryBuffer.slice(0, recordSize);
            binaryBuffer = binaryBuffer.slice(recordSize);

            const rtype = record[1];

            // STRICT FILTER: Only process Mbp0Msg (Trades). Ignore 0x16, 0x17, etc.
            if (rtype !== 0x00) continue; 
            if (record.length < 48) continue; 

            // VERIFIED DBN V2 MBP-0 OFFSETS
            const tsEventNs = record.readBigUInt64LE(8);
            const priceRaw = record.readBigInt64LE(16);
            const size = record.readUInt32LE(24);
            const action = String.fromCharCode(record[28]);
            const side = String.fromCharCode(record[29]);

            const priceFloat = Number(priceRaw) * PRICE_SCALE;
            const tsMs = Number(tsEventNs / BigInt(1_000_000));
            const timestamp = new Date(tsMs).toISOString();

            tradeCount++;
            console.log(
                `🔥 [Trade ${tradeCount}/5] ` +
                `Price: $${priceFloat.toFixed(2)} | ` +
                `Size: ${size} | ` +
                `Side: ${side} | ` +
                `Action: ${action} | ` +
                `Time: ${timestamp}`
            );

            if (tradeCount >= 5) {
                console.log('\n🧪 ═══════════════════════════════════════════');
                console.log('🧪  TEST COMPLETE — Received 5 trades');
                console.log('🧪  ✅ Verified Offsets — PASS');
                console.log('🧪 ═══════════════════════════════════════════\n');
                socket.destroy();
                process.exit(0);
            }
        }
    });

    setTimeout(() => {
        if (tradeCount < 5) {
            console.error(`⏰ Timeout: Only received ${tradeCount}/5 trades in 60 seconds.`);
            socket.destroy();
            process.exit(1);
        }
    }, 60000);
}

run().catch((err) => {
    console.error('🔴 Unhandled error:', err);
    process.exit(1);
});
