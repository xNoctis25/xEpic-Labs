import * as net    from 'net';
import * as crypto from 'crypto';
import { Tick }    from '../market/CandleAggregator';
import { hydrate, waitForDataAvailability, HydrationPayload } from './DatabentoHistoricalService';

// ─── Constants ──────────────────────────────────────────────────────────────

const LSG_PORT   = 13000;
const SCHEMA     = 'trades';
const PRICE_SCALE = 1e-9;

// ─── Datasets ────────────────────────────────────────────────────────────────
export const CME_DATASET = 'GLBX.MDP3';   // ES / MES (CME)
export const CFE_DATASET = 'XCBF.PITCH';   // VX  (CBOE Futures Exchange / CFE)

// ─── Types ───────────────────────────────────────────────────────────────────

/** Enriched tick: includes which dataset + symbol produced the trade */
export interface EnrichedTick extends Tick {
    dataset: string;   // 'GLBX.MDP3' | 'XCBT.MDP3'
    symbol:  string;   // e.g. 'ES.c.0', 'VX.c.0'
}

export interface FeedConfig {
    dataset:  string;    // Databento dataset ID
    symbols:  string[];  // Continuous-symbology symbols for this dataset
    label:    string;    // Human-readable label for logs
    host:     string;
}

// ─── Hardcoded multicast configs ─────────────────────────────────────────────
export const CME_CONFIG: FeedConfig = {
    dataset: CME_DATASET,
    symbols: ['ES.c.0', 'MES.c.0'],
    label:   'CME (ES + MES)',
    host:    'glbx-mdp3.lsg.databento.com',
};

export const CFE_CONFIG: FeedConfig = {
    dataset: CFE_DATASET,
    symbols: ['VX.c.0'],
    label:   'CFE (VX/VIX)',
    host:    'xcbf-pitch.lsg.databento.com',
};

// ─────────────────────────────────────────────────────────────────────────────
// SingleFeedConnection
// ─────────────────────────────────────────────────────────────────────────────
/**
 * One TCP connection to the Databento LSG for a single dataset.
 * Handles CRAM auth, subscription, DBN V2 binary parsing, and
 * emits EnrichedTick objects to the provided callback.
 */
class SingleFeedConnection {
    private socket: net.Socket | null = null;
    private readonly config:   FeedConfig;
    private readonly apiKey:   string;
    private readonly onTick:   (tick: EnrichedTick) => void;
    private readonly onStatus: (label: string, status: string) => void;

    constructor(
        config:   FeedConfig,
        apiKey:   string,
        onTick:   (tick: EnrichedTick) => void,
        onStatus: (label: string, status: string) => void,
    ) {
        this.config   = config;
        this.apiKey   = apiKey;
        this.onTick   = onTick;
        this.onStatus = onStatus;
    }

    public connect(): void {
        const { dataset, symbols, label, host } = this.config;
        console.log(`📡 [Databento/${label}] Connecting to ${host}:${LSG_PORT}…`);

        this.socket = net.createConnection({ host: host, port: LSG_PORT });

        let state: 'GREETING' | 'CHALLENGE' | 'AUTH_RESPONSE' | 'STREAMING' = 'GREETING';
        let binaryBuffer  = Buffer.alloc(0);
        let metadataSkipped = false;
        let textBuffer    = '';

        this.socket.on('connect', () => {
            this.onStatus(label, 'TCP_CONNECTED');
        });

        this.socket.on('data', (data: Buffer) => {

            // ── Text-based gateway handshake ─────────────────────────────────
            if (state !== 'STREAMING') {
                textBuffer += data.toString('utf-8');

                while (textBuffer.includes('\n')) {
                    const nlIdx = textBuffer.indexOf('\n');
                    const line  = textBuffer.slice(0, nlIdx + 1);
                    textBuffer  = textBuffer.slice(nlIdx + 1);

                    const fields: Record<string, string> = {};
                    for (const token of line.trim().split('|')) {
                        const eq = token.indexOf('=');
                        if (eq !== -1) fields[token.slice(0, eq)] = token.slice(eq + 1);
                    }

                    if (state === 'GREETING' && fields['lsg_version']) {
                        state = 'CHALLENGE';
                        continue;
                    }

                    if (state === 'CHALLENGE' && fields['cram']) {
                        const bucketId  = this.apiKey.slice(-5);
                        const sha256    = crypto.createHash('sha256')
                            .update(`${fields['cram']}|${this.apiKey}`)
                            .digest('hex');
                        const response  = `${sha256}-${bucketId}`;
                        const authMsg   = [
                            `auth=${response}`,
                            `dataset=${dataset}`,
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
                            this.onStatus(label, 'AUTH_OK');

                            // ── Subscribe to ALL symbols in one message ──────
                            const subMsg = [
                                `schema=${SCHEMA}`,
                                `stype_in=continuous`,
                                `symbols=${symbols.join(',')}`,
                                `snapshot=0`,
                                `is_last=1`,
                            ].join('|') + '\n';
                            this.socket!.write(subMsg);
                            this.socket!.write('start_session\n');

                            console.log(`✅ [Databento/${label}] Subscribed → ${symbols.join(', ')}`);
                            state = 'STREAMING';

                            if (textBuffer.length > 0) {
                                binaryBuffer = Buffer.concat([binaryBuffer, Buffer.from(textBuffer, 'binary')]);
                                textBuffer = '';
                            }
                        } else {
                            console.error(`❌ [Databento/${label}] CRAM failed: ${fields['error'] || 'unknown'}`);
                            this.socket!.destroy();
                        }
                        continue;
                    }
                }
                return;
            }

            // ── Binary DBN stream ─────────────────────────────────────────────
            binaryBuffer = Buffer.concat([binaryBuffer, data]);

            // Skip the metadata header once
            if (!metadataSkipped) {
                const dbnMagicIdx = binaryBuffer.indexOf(Buffer.from([0x44, 0x42, 0x4E]));
                if (dbnMagicIdx === -1 || binaryBuffer.length < dbnMagicIdx + 8) return;
                const metaLength    = binaryBuffer.readUInt32LE(dbnMagicIdx + 4);
                const totalMetaSize = dbnMagicIdx + 8 + metaLength;
                if (binaryBuffer.length < totalMetaSize) return;
                binaryBuffer    = binaryBuffer.slice(totalMetaSize);
                metadataSkipped = true;
            }

            // Drain complete records
            while (binaryBuffer.length >= 4) {
                const recordSize = binaryBuffer[0] * 4;
                if (recordSize === 0 || binaryBuffer.length < recordSize) break;

                const record = binaryBuffer.slice(0, recordSize);
                binaryBuffer = binaryBuffer.slice(recordSize);

                // Only MBP-0 (trade) records
                if (record[1] !== 0x00 || record.length < 48) continue;

                const tsEventNs  = record.readBigUInt64LE(8);
                const priceRaw   = record.readBigInt64LE(16);
                const size       = record.readUInt32LE(24);
                const priceFloat = Number(priceRaw) * PRICE_SCALE;
                const tsMs       = Number(tsEventNs / BigInt(1_000_000));

                // ── MULTICAST: emit enriched tick ─────────────────────────
                // The caller (OracleWorker) fans this to momPort, assistPort,
                // and parentPort in a single synchronous call per tick.
                this.onTick({
                    price:     priceFloat,
                    volume:    size,
                    timestamp: tsMs,
                    dataset,
                    // Resolve the primary trading symbol from the subscription
                    symbol: symbols[0],
                });
            }
        });

        this.socket.on('error', (err) => {
            console.error(`❌ [Databento/${label}] Socket error: ${err.message}`);
            this.onStatus(label, `ERROR:${err.message}`);
        });

        this.socket.on('close', () => {
            console.log(`🔌 [Databento/${label}] Connection closed.`);
            this.onStatus(label, 'CLOSED');
        });
    }

    public disconnect(): void {
        this.socket?.destroy();
        this.socket = null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DatabentoLiveService — Public API
// ─────────────────────────────────────────────────────────────────────────────
export class DatabentoLiveService {
    private cmeConn: SingleFeedConnection | null = null;
    private cfeConn: SingleFeedConnection | null = null;
    private firstTickTimestamp: number | null = null;
    private _feedStartTime: number = 0;
    private broadcastTick: ((tick: EnrichedTick) => void) | null = null;

    /** Wall-clock time (Date.now()) when the feed first connected and ticks started flowing. */
    public get feedStartTime(): number { return this._feedStartTime; }

    /**
     * Phase 1: Connect both feeds and stream ticks immediately.
     * NO hydration happens here -- call hydrateGap() separately after the test trade.
     */
    public start(
        onTick:    (tick: EnrichedTick) => void,
        onStatus?: (label: string, status: string) => void,
    ): void {
        const apiKey = (process.env.DATABENTO_API_KEY || '').trim();
        if (!apiKey) throw new Error('DATABENTO_API_KEY not set in .env');

        this.broadcastTick = onTick;
        const statusCb = onStatus ?? (() => {});

        this.cmeConn = new SingleFeedConnection(CME_CONFIG, apiKey, (tick) => {
            if (!this.firstTickTimestamp) {
                this.firstTickTimestamp = tick.timestamp;
                this._feedStartTime = Date.now();
            }
            if (this.broadcastTick) this.broadcastTick(tick);
        }, statusCb);

        this.cfeConn = new SingleFeedConnection(CFE_CONFIG, apiKey, (tick) => {
            if (this.broadcastTick) this.broadcastTick(tick);
        }, statusCb);

        this.cmeConn.connect();
        this.cfeConn.connect();
    }

    /**
     * Phase 2: Fetch historical data and return it.
     * Called AFTER the test trade succeeds. Polls Databento metadata until
     * both CME and CFE have data up to firstTickTimestamp, then fetches.
     * Live candles have been building since firstTickTimestamp → ZERO GAP.
     */
    public async hydrateGap(): Promise<HydrationPayload> {
        const endTime = this.firstTickTimestamp || Date.now();

        // Wait until Databento has processed data up to our stitch point
        console.log('[Hydration] Waiting for Databento to process data up to feed start...');
        const [cmeReady, cfeReady] = await Promise.all([
            waitForDataAvailability(CME_DATASET, endTime),
            waitForDataAvailability(CFE_DATASET, endTime),
        ]);

        if (!cmeReady) console.warn('[Hydration] CME data not available in time — starting cold.');
        if (!cfeReady) console.warn('[Hydration] CFE data not available in time — starting cold.');

        const [cmeCandles, cfeCandles] = await Promise.all([
            cmeReady ? hydrate(CME_DATASET, CME_CONFIG.symbols, 60, endTime) : Promise.resolve([]),
            cfeReady ? hydrate(CFE_DATASET, CFE_CONFIG.symbols, 60, endTime) : Promise.resolve([]),
        ]);

        cmeCandles.sort((a, b) => a.timestamp - b.timestamp);
        cfeCandles.sort((a, b) => a.timestamp - b.timestamp);

        return { cmeCandles, cfeCandles };
    }

    /** Gracefully tears down both TCP connections. */
    public disconnect(): void {
        this.cmeConn?.disconnect();
        this.cfeConn?.disconnect();
        this.cmeConn = null;
        this.cfeConn = null;
    }
}
