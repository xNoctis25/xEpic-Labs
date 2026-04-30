import * as net    from 'net';
import * as crypto from 'crypto';
import { Tick }    from '../market/CandleAggregator';
import { hydrate, HydrationPayload } from './DatabentoHistoricalService';

// ─── Constants ──────────────────────────────────────────────────────────────
const LSG_HOST   = 'glbx-mdp3.lsg.databento.com';
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

/** Single feed subscription configuration */
export interface FeedConfig {
    dataset:  string;    // Databento dataset ID
    symbols:  string[];  // Continuous-symbology symbols for this dataset
    label:    string;    // Human-readable label for logs
}

// ─── Hardcoded multicast configs ─────────────────────────────────────────────
export const CME_CONFIG: FeedConfig = {
    dataset: CME_DATASET,
    symbols: ['ES.c.0', 'MES.c.0'],
    label:   'CME (ES + MES)',
};

export const CFE_CONFIG: FeedConfig = {
    dataset: CFE_DATASET,
    symbols: ['VX.c.0'],
    label:   'CFE (VX/VIX)',
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
        const { dataset, symbols, label } = this.config;
        console.log(`📡 [Databento/${label}] Connecting to ${LSG_HOST}:${LSG_PORT}…`);

        this.socket = net.createConnection({ host: LSG_HOST, port: LSG_PORT });

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

                // ── MULTICAST: emit enriched tick ─────────────────────────────
                // The caller (OracleWorker) fans this to momPort, assistPort,
                // and parentPort in a single synchronous call per tick.
                this.onTick({
                    price:     priceFloat,
                    volume:    size,
                    timestamp: tsMs,
                    dataset,
                    // symbol resolved from publisher_id lookup — left as dataset label for now
                    symbol: label,
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
/**
 * Manages simultaneous CME (ES/MES) + CFE (VX) Databento TCP feeds.
 *
 * On every incoming trade tick from EITHER feed, `onTick` is called with an
 * EnrichedTick that includes `dataset` and `symbol` so the consumer (OracleWorker)
 * can route or filter by instrument class.
 *
 * The consumer is responsible for multicasting the tick across the IPC mesh
 * (momPort, assistPort, parentPort) to achieve zero-latency fan-out.
 */
export class DatabentoLiveService {
    private cmeConn: SingleFeedConnection | null = null;
    private cfeConn: SingleFeedConnection | null = null;

    private isHydrating: boolean = true;
    private hydrationStarted: boolean = false;
    private liveBuffer: EnrichedTick[] = [];
    private firstTickTimestamp: number | null = null;

    private broadcastTick: ((tick: EnrichedTick) => void) | null = null;
    private onHydrationCallback: ((payload: HydrationPayload) => void) | null = null;

    /**
     * Starts both CME and CFE feeds simultaneously.
     *
     * @param onTick      Called for every trade tick from either dataset.
     * @param onHydration Called once with historical zero-gap stitched data.
     * @param onStatus    Optional status callback (label, status string).
     */
    public start(
        onTick:      (tick: EnrichedTick) => void,
        onHydration: (payload: HydrationPayload) => void,
        onStatus?:   (label: string, status: string) => void,
    ): void {
        const apiKey = (process.env.DATABENTO_API_KEY || '').trim();
        if (!apiKey) throw new Error('DATABENTO_API_KEY not set in .env');

        this.broadcastTick = onTick;
        this.onHydrationCallback = onHydration;

        const statusCb = onStatus ?? ((label, s) => console.log(`[Databento/${label}] ${s}`));

        this.cmeConn = new SingleFeedConnection(CME_CONFIG, apiKey, this.handleTick.bind(this), statusCb);
        this.cfeConn = new SingleFeedConnection(CFE_CONFIG, apiKey, this.handleTick.bind(this), statusCb);

        this.cmeConn.connect();
        this.cfeConn.connect();

        console.log('🌐 [DatabentoLiveService] CME + CFE feeds starting simultaneously…');
    }

    private handleTick(tick: EnrichedTick): void {
        if (this.isHydrating) {
            this.liveBuffer.push(tick);
            
            // Trigger the fetch exactly ONCE on the very first tick
            if (!this.hydrationStarted) {
                this.hydrationStarted = true;
                this.firstTickTimestamp = tick.timestamp; // Use exact nanosecond/ms timestamp
                this.fetchAndStitchGap(this.firstTickTimestamp);
            }
            return; // Do not broadcast live ticks yet
        }
        
        // If not hydrating, broadcast normally
        if (this.broadcastTick) {
            this.broadcastTick(tick);
        }
    }

    private async fetchAndStitchGap(endTime: number) {
        try {
            const startTime = endTime - (60 * 60 * 1000); // 60 mins before endTime
            console.log(`[DatabentoLiveService] 💧 Starting Zero-Gap Stitching Hydration...`);
            console.log(`[DatabentoLiveService] Fetching historical data from ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);
            
            const [cmeCandles, cfeCandles] = await Promise.all([
                hydrate(CME_DATASET, CME_CONFIG.symbols, 60, endTime),
                hydrate(CFE_DATASET, CFE_CONFIG.symbols, 60, endTime),
            ]);

            // Parse and sort the historical data by timestamp.
            cmeCandles.sort((a, b) => a.timestamp - b.timestamp);
            cfeCandles.sort((a, b) => a.timestamp - b.timestamp);

            const payload: HydrationPayload = { cmeCandles, cfeCandles };

            // Broadcast the historical array
            if (this.onHydrationCallback) {
                this.onHydrationCallback(payload);
            }

            // Wait for a brief tick to ensure workers process the history.
            await new Promise(r => setTimeout(r, 100));

            // The Flush: Loop through this.liveBuffer and broadcast every trapped live tick natively.
            console.log(`[DatabentoLiveService] 💧 Flushing ${this.liveBuffer.length} trapped live ticks from buffer.`);
            for (const trapped of this.liveBuffer) {
                if (this.broadcastTick) {
                    this.broadcastTick(trapped);
                }
            }

            this.isHydrating = false;
            this.liveBuffer = [];
            console.log(`[DatabentoLiveService] ✅ Zero-Gap Stitching Complete. Now streaming live.`);

        } catch (error) {
            console.error('[DatabentoLiveService] ❌ Hydration failed:', error);
            // Fallback: just flush what we have and proceed
            this.isHydrating = false;
            for (const trapped of this.liveBuffer) {
                if (this.broadcastTick) {
                    this.broadcastTick(trapped);
                }
            }
            this.liveBuffer = [];
        }
    }

    /** Gracefully tears down both TCP connections. */
    public disconnect(): void {
        this.cmeConn?.disconnect();
        this.cfeConn?.disconnect();
        this.cmeConn = null;
        this.cfeConn = null;
        console.log('🔌 [DatabentoLiveService] Both feeds disconnected.');
    }
}
