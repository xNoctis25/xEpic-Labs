/**
 * ═══════════════════════════════════════════════════════════════
 *  DATABENTO LIVE TEST — Raw TCP Gateway Verification
 * ═══════════════════════════════════════════════════════════════
 *
 * Connects to Databento's Live Subscription Gateway (LSG) via raw
 * TCP, authenticates with CRAM, subscribes to MESM6 trades, and
 * prints the first 5 trade records before disconnecting.
 *
 * Protocol reference: databento-python/databento/live/protocol.py
 *
 * Usage:
 *   npx ts-node src/scripts/testDatabentoLive.ts
 */

import * as dotenv from 'dotenv';
dotenv.config();

import * as net from 'net';
import * as crypto from 'crypto';

// ─── Constants ─────────────────────────────────────────────────
const LSG_HOST = 'dc3.databento.com';
const LSG_PORT = 13000;
const DATASET = 'GLBX.MDP3';
const SYMBOL = 'MESM6';
const SCHEMA = 'trades';

const PRICE_SCALE = 1e-9;   // DBN fixed-point: 1 unit = $0.000000001

// DBN TradeMsg layout (after Metadata header):
//   RecordHeader: 16 bytes (length:1, rtype:1, publisher_id:2, instrument_id:4, ts_event:8)
//   ts_recv:      8 bytes (uint64)
//   ts_in_delta:  4 bytes (int32)
//   sequence:     4 bytes (uint32)
//   price:        8 bytes (int64, fixed-point 1e-9)
//   size:         4 bytes (uint32)
//   action:       1 byte  (char)
//   side:         1 byte  (char)
//   depth:        1 byte  (uint8)
//   flags:        1 byte  (uint8)
// Total TradeMsg: 48 bytes

const RECORD_HEADER_SIZE = 16;

// ─── CRAM Authentication ───────────────────────────────────────
function cramResponse(challenge: string, apiKey: string): string {
    const bucketId = apiKey.slice(-5);
    const sha256 = crypto.createHash('sha256')
        .update(`${challenge}|${apiKey}`)
        .digest('hex');
    return `${sha256}-${bucketId}`;
}

// ─── Helpers ───────────────────────────────────────────────────
/** Read a signed 64-bit integer (little-endian) from a Buffer. */
function readInt64LE(buf: Buffer, offset: number): bigint {
    return buf.readBigInt64LE(offset);
}

/** Read an unsigned 64-bit integer (little-endian) from a Buffer. */
function readUInt64LE(buf: Buffer, offset: number): bigint {
    return buf.readBigUInt64LE(offset);
}

// ─── Main Test ─────────────────────────────────────────────────
async function run(): Promise<void> {
    const apiKey = (process.env.DATABENTO_API_KEY || '').trim();
    if (!apiKey) {
        console.error('❌ DATABENTO_API_KEY not set in .env');
        process.exit(1);
    }

    console.log('\n🧪 ═══════════════════════════════════════════');
    console.log('🧪  DATABENTO LIVE TEST — Raw TCP Gateway');
    console.log('🧪 ═══════════════════════════════════════════\n');

    console.log(`📡 Connecting to ${LSG_HOST}:${LSG_PORT}...`);

    const socket = net.createConnection({ host: LSG_HOST, port: LSG_PORT });

    // ── State machine ──────────────────────────────────────────
    let state: 'GREETING' | 'CHALLENGE' | 'AUTH_RESPONSE' | 'STREAMING' = 'GREETING';
    let tradeCount = 0;
    let binaryBuffer = Buffer.alloc(0);
    let metadataSkipped = false;
    let textBuffer = '';  // Buffer for text-based gateway messages

    socket.on('connect', () => {
        console.log('✅ TCP connection established. Waiting for greeting...\n');
    });

    socket.on('data', (data: Buffer) => {
        // ── Text-based gateway handshake ────────────────────────
        if (state !== 'STREAMING') {
            textBuffer += data.toString('utf-8');

            // Process complete lines
            while (textBuffer.includes('\n')) {
                const newlineIdx = textBuffer.indexOf('\n');
                const line = textBuffer.slice(0, newlineIdx + 1);
                textBuffer = textBuffer.slice(newlineIdx + 1);

                console.log(`[GATEWAY] ${line.trim()}`);

                // Parse pipe-delimited key=value pairs
                const fields: Record<string, string> = {};
                for (const token of line.trim().split('|')) {
                    const eqIdx = token.indexOf('=');
                    if (eqIdx !== -1) {
                        fields[token.slice(0, eqIdx)] = token.slice(eqIdx + 1);
                    }
                }

                if (state === 'GREETING' && fields['lsg_version']) {
                    console.log(`   → LSG Version: ${fields['lsg_version']}`);
                    state = 'CHALLENGE';
                    continue;
                }

                if (state === 'CHALLENGE' && fields['cram']) {
                    const challenge = fields['cram'];
                    const response = cramResponse(challenge, apiKey);
                    console.log(`   → CRAM challenge received. Sending auth response...`);

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
                        console.log(`   → Authentication SUCCESS (session: ${fields['session_id'] || 'n/a'})`);
                        console.log(`\n📡 Subscribing to ${SYMBOL} ${SCHEMA}...`);

                        // Send subscription
                        const subMsg = [
                            `schema=${SCHEMA}`,
                            `stype_in=raw_symbol`,
                            `symbols=${SYMBOL}`,
                            `snapshot=0`,
                            `is_last=1`,
                        ].join('|') + '\n';
                        socket.write(subMsg);

                        // Send session start
                        socket.write('start_session=0\n');

                        console.log(`✅ Subscribed. Waiting for first 5 trades...\n`);
                        state = 'STREAMING';

                        // If there's leftover data in textBuffer, it may be start of binary
                        if (textBuffer.length > 0) {
                            binaryBuffer = Buffer.concat([binaryBuffer, Buffer.from(textBuffer, 'binary')]);
                            textBuffer = '';
                        }
                    } else {
                        console.error(`❌ Authentication FAILED: ${fields['error'] || 'unknown error'}`);
                        socket.destroy();
                        process.exit(1);
                    }
                    continue;
                }
            }
            return;
        }

        // ── Binary DBN stream ──────────────────────────────────
        binaryBuffer = Buffer.concat([binaryBuffer, data]);

        // Skip the Metadata header on first binary data
        // The Metadata header starts with a variable-length structure.
        // We scan for the first record by looking for valid record headers.
        if (!metadataSkipped) {
            // DBN Metadata has a magic prefix "DBN" (0x44, 0x42, 0x4E)
            // We need to skip past the entire Metadata block.
            // The Metadata starts with: version(1) + length(4) + schema(2) + ...
            // Simplest approach: scan for trade records by looking at rtype patterns.
            // 
            // Actually the Metadata has a defined_length field at bytes 4-7 (uint32 LE)
            // after the 4-byte prefix "DBN\x01" (magic + version).
            const dbnMagicIdx = binaryBuffer.indexOf(Buffer.from([0x44, 0x42, 0x4E]));
            if (dbnMagicIdx === -1) {
                // No metadata yet, wait for more data
                return;
            }

            // Check we have enough bytes for the metadata length field
            if (binaryBuffer.length < dbnMagicIdx + 8) return;

            // Read the metadata length (bytes 4-7 after magic, little-endian uint32)
            const metaLength = binaryBuffer.readUInt32LE(dbnMagicIdx + 4);
            const totalMetaSize = dbnMagicIdx + 4 + metaLength; // prefix(4) + declared_length

            if (binaryBuffer.length < totalMetaSize) {
                // Haven't received full metadata yet
                return;
            }

            console.log(`📦 [DBN] Metadata received (${totalMetaSize} bytes). Parsing trade records...\n`);
            binaryBuffer = binaryBuffer.slice(totalMetaSize);
            metadataSkipped = true;
        }

        // Process complete records from the buffer
        while (binaryBuffer.length >= 4) {
            // First byte is record length in 4-byte words
            const lengthWords = binaryBuffer[0];
            const recordSize = lengthWords * 4;

            if (recordSize === 0 || binaryBuffer.length < recordSize) break;

            // Extract this record
            const record = binaryBuffer.slice(0, recordSize);
            binaryBuffer = binaryBuffer.slice(recordSize);

            // RecordHeader fields
            const rtype = record[1];

            // TradeMsg rtype: check for MBP-0 (trades schema uses rtype 0x00 or specific values)
            // The ts_event is at offset 8 (uint64 LE)
            if (record.length < 48) continue; // Not a full trade record

            const tsEventNs = readUInt64LE(record, 8);
            const priceRaw = readInt64LE(record, 32);
            const size = record.readUInt32LE(40);
            const action = String.fromCharCode(record[44]);
            const side = String.fromCharCode(record[45]);

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
                console.log('🧪  ✅ TCP Connect  — PASS');
                console.log('🧪  ✅ CRAM Auth    — PASS');
                console.log('🧪  ✅ Subscribe    — PASS');
                console.log('🧪  ✅ Trade Stream — PASS');
                console.log('🧪 ═══════════════════════════════════════════\n');
                socket.destroy();
                process.exit(0);
            }
        }
    });

    socket.on('error', (err) => {
        console.error('❌ Socket error:', err.message);
        process.exit(1);
    });

    socket.on('close', () => {
        console.log('🔌 Connection closed.');
        if (tradeCount < 5) {
            console.log(`⚠️  Only received ${tradeCount}/5 trades before disconnect.`);
        }
        process.exit(tradeCount >= 5 ? 0 : 1);
    });

    // Timeout safety — if nothing happens in 30 seconds, bail
    setTimeout(() => {
        if (tradeCount < 5) {
            console.error(`⏰ Timeout: Only received ${tradeCount}/5 trades in 30 seconds.`);
            console.error('   This may mean the market is closed or the subscription was rejected.');
            socket.destroy();
            process.exit(1);
        }
    }, 30000);
}

// ─── Execute ───────────────────────────────────────────────────
run().catch((err) => {
    console.error('🔴 Unhandled error:', err);
    process.exit(1);
});
