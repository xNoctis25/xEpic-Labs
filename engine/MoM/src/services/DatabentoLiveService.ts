import * as net from 'net';
import * as crypto from 'crypto';
import { Tick } from '../market/CandleAggregator';
import { config } from '../config/env';

// ─── Constants ─────────────────────────────────────────────────
const LSG_HOST = 'glbx-mdp3.lsg.databento.com';
const LSG_PORT = 13000;
const DATASET = 'GLBX.MDP3';
const SCHEMA = 'trades';
const PRICE_SCALE = 1e-9;

/**
 * DatabentoLiveService — Raw TCP Market Data Feed
 *
 * Connects to the Databento Live Subscription Gateway (LSG) via raw TCP,
 * authenticates with CRAM, subscribes to trades for a given symbol using
 * continuous front-month symbology (MES.c.0), and parses DBN V2 binary
 * records into Tick objects for the CandleAggregator.
 *
 * Protocol verified against databento-python source:
 *   - gateway.py  (message framing)
 *   - protocol.py (handshake state machine)
 *   - cram.py     (challenge-response auth)
 */
export class DatabentoLiveService {
    private socket: net.Socket | null = null;

    // ─── CRAM Authentication ───────────────────────────────────
    private cramResponse(challenge: string, apiKey: string): string {
        const bucketId = apiKey.slice(-5);
        const sha256 = crypto.createHash('sha256')
            .update(`${challenge}|${apiKey}`)
            .digest('hex');
        return `${sha256}-${bucketId}`;
    }

    /**
     * Connects to the Databento LSG, authenticates, subscribes to trades
     * for the given symbol, and begins streaming ticks to the callback.
     *
     * Uses continuous front-month symbology (e.g., 'MES.c.0') so the
     * gateway automatically resolves to the active front-month contract.
     *
     * @param symbol   - Continuous symbol (e.g., 'MES.c.0')
     * @param onTick   - Callback invoked for each parsed trade
     */
    public start(symbol: string, onTick: (tick: Tick) => void): void {
        const apiKey = (process.env.DATABENTO_API_KEY || '').trim();
        if (!apiKey) {
            throw new Error('DATABENTO_API_KEY not set in .env');
        }

        console.log(`📡 [Databento] Connecting to ${LSG_HOST}:${LSG_PORT}...`);

        this.socket = net.createConnection({ host: LSG_HOST, port: LSG_PORT });

        let state: 'GREETING' | 'CHALLENGE' | 'AUTH_RESPONSE' | 'STREAMING' = 'GREETING';
        let binaryBuffer = Buffer.alloc(0);
        let metadataSkipped = false;
        let textBuffer = '';

        this.socket.on('connect', () => {
            console.log('✅ [Databento] TCP connection established.');
        });

        this.socket.on('data', (data: Buffer) => {
            // ── Text-based gateway handshake ────────────────────
            if (state !== 'STREAMING') {
                textBuffer += data.toString('utf-8');

                while (textBuffer.includes('\n')) {
                    const newlineIdx = textBuffer.indexOf('\n');
                    const line = textBuffer.slice(0, newlineIdx + 1);
                    textBuffer = textBuffer.slice(newlineIdx + 1);

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
                        const response = this.cramResponse(challenge, apiKey);
                        const authMsg = [
                            `auth=${response}`,
                            `dataset=${DATASET}`,
                            `encoding=dbn`,
                            `ts_out=0`,
                            `compression=none`,
                        ].join('|') + '\n';

                        this.socket!.write(authMsg);
                        state = 'AUTH_RESPONSE';
                        continue;
                    }

                    if (state === 'AUTH_RESPONSE' && fields['success'] !== undefined) {
                        if (fields['success'] === '1') {
                            console.log(`✅ [Databento] CRAM Auth SUCCESS (session: ${fields['session_id'] || 'n/a'})`);
                            console.log(`📡 [Databento] Subscribing to ${symbol} ${SCHEMA}...`);

                            const subMsg = [
                                `schema=${SCHEMA}`,
                                `stype_in=continuous`,
                                `symbols=${symbol}`,
                                `snapshot=0`,
                                `is_last=1`,
                            ].join('|') + '\n';
                            this.socket!.write(subMsg);

                            // start_session with NO arguments
                            this.socket!.write('start_session\n');

                            console.log(`✅ [Databento] Subscribed. Streaming trades...`);
                            state = 'STREAMING';

                            // Flush leftover text as binary
                            if (textBuffer.length > 0) {
                                binaryBuffer = Buffer.concat([binaryBuffer, Buffer.from(textBuffer, 'binary')]);
                                textBuffer = '';
                            }
                        } else {
                            console.error(`❌ [Databento] CRAM Auth FAILED: ${fields['error'] || 'unknown'}`);
                            this.socket!.destroy();
                        }
                        continue;
                    }
                }
                return;
            }

            // ── Binary DBN stream ──────────────────────────────
            binaryBuffer = Buffer.concat([binaryBuffer, data]);

            // Skip the Metadata header on first binary data
            if (!metadataSkipped) {
                const dbnMagicIdx = binaryBuffer.indexOf(Buffer.from([0x44, 0x42, 0x4E]));
                if (dbnMagicIdx === -1) return;
                if (binaryBuffer.length < dbnMagicIdx + 8) return;

                const metaLength = binaryBuffer.readUInt32LE(dbnMagicIdx + 4);
                // +8 to account for Magic (4 bytes) and Length (4 bytes) fields
                const totalMetaSize = dbnMagicIdx + 8 + metaLength;

                if (binaryBuffer.length < totalMetaSize) return;

                console.log(`📦 [Databento] Metadata received (${totalMetaSize} bytes). Parsing trade records...`);
                binaryBuffer = binaryBuffer.slice(totalMetaSize);
                metadataSkipped = true;
            }

            // Process complete records from the buffer
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

                const priceFloat = Number(priceRaw) * PRICE_SCALE;
                const tsMs = Number(tsEventNs / BigInt(1_000_000));

                onTick({
                    price: priceFloat,
                    volume: size,
                    timestamp: tsMs,
                });
            }
        });

        this.socket.on('error', (err) => {
            console.error('❌ [Databento] Socket error:', err.message);
        });

        this.socket.on('close', () => {
            console.log('🔌 [Databento] Connection closed.');
        });
    }

    /**
     * Gracefully disconnects the TCP socket.
     */
    public disconnect(): void {
        if (this.socket) {
            this.socket.destroy();
            this.socket = null;
        }
    }
}
