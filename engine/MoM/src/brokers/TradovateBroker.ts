import WebSocket from 'ws';
import axios, { AxiosInstance } from 'axios';
import { config as dotEnvConfig } from 'dotenv';
import { Tick } from '../market/CandleAggregator';

dotEnvConfig();

/** Token refresh interval: 1 hour (ms). Tradovate tokens expire after a few hours. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

export class TradovateBroker {
    private ws: WebSocket | null = null;
    private isConnected: boolean = false;
    private accessToken: string = '';

    // --- Token lifecycle ---
    /** Epoch timestamp (ms) of the last successful token acquisition */
    private tokenAcquiredAt: number = 0;
    /** Mutex: if a refresh is already in flight, all callers await the same promise */
    private refreshPromise: Promise<void> | null = null;

    // --- Tradovate REST API Base URL ---
    // Switch to 'https://live.tradovateapi.com/v1' for production
    private readonly REST_BASE = 'https://demo.tradovateapi.com/v1';
    private readonly AUTH_URL = 'https://demo.tradovateapi.com/v1/auth/accesstokenrequest';

    /** Shared Axios instance – headers are updated on every token refresh */
    private axiosInstance: AxiosInstance;

    // Cached account ID (resolved once on first use)
    private accountId: number | null = null;
    private accountSpec: string = '';

    constructor() {
        this.axiosInstance = axios.create({
            baseURL: this.REST_BASE,
            timeout: 10000,
            headers: { 'Content-Type': 'application/json' },
        });
    }

    // ─── Token Management ──────────────────────────────────────────────

    /**
     * Requests a fresh OAuth access token from Tradovate and updates the
     * shared Axios instance headers.
     */
    private async requestToken(): Promise<void> {
        console.log("🔐 [TradovateBroker] - Requesting OAuth Access Token...");

        const response = await axios.post(this.AUTH_URL, {
            name: process.env.TRADOVATE_USERNAME,
            password: process.env.TRADOVATE_PASSWORD,
            appId: process.env.TRADOVATE_APP_ID,
            appVersion: process.env.TRADOVATE_APP_VERSION,
            cid: process.env.TRADOVATE_CLIENT_ID,
            sec: process.env.TRADOVATE_CLIENT_SECRET,
        });

        this.accessToken = response.data.accessToken;
        this.tokenAcquiredAt = Date.now();
        this.axiosInstance.defaults.headers.common['Authorization'] = `Bearer ${this.accessToken}`;

        console.log("✅ [TradovateBroker] - OAuth Token Acquired / Refreshed.");
    }

    /**
     * Proactively refreshes the token if it is older than TOKEN_TTL_MS (1 hour).
     * Uses a mutex so concurrent callers share the same in-flight refresh.
     */
    private async refreshTokenIfNeeded(): Promise<void> {
        const age = Date.now() - this.tokenAcquiredAt;
        if (age < TOKEN_TTL_MS) return; // Token is still fresh

        // If another caller is already refreshing, piggyback on that promise
        if (this.refreshPromise) {
            await this.refreshPromise;
            return;
        }

        console.log(`🔄 [TradovateBroker] - Token age ${Math.round(age / 60000)}m exceeds TTL. Refreshing...`);

        this.refreshPromise = this.requestToken()
            .catch((err) => {
                console.error("🔴 [TradovateBroker] - Token refresh FAILED:", err.response?.data || err.message);
                throw err;
            })
            .finally(() => {
                this.refreshPromise = null;
            });

        await this.refreshPromise;
    }

    /**
     * Reactive 401 handler: if an API call returns 401 Unauthorized,
     * refresh the token once and retry the original request.
     */
    private async withTokenRetry<T>(apiFn: () => Promise<T>): Promise<T> {
        try {
            return await apiFn();
        } catch (error: any) {
            if (error.response?.status === 401) {
                console.warn("⚠️ [TradovateBroker] - 401 received. Forcing token refresh and retrying...");
                // Invalidate so refreshTokenIfNeeded() will act
                this.tokenAcquiredAt = 0;
                await this.refreshTokenIfNeeded();
                return await apiFn(); // Retry once
            }
            throw error;
        }
    }

    // ─── Connection ────────────────────────────────────────────────────

    public async connect(): Promise<boolean> {
        try {
            // 1. Get the OAuth Token via REST
            await this.requestToken();

            // 2. Connect to the WebSocket
            return new Promise((resolve) => {
                this.ws = new WebSocket('wss://md.tradovateapi.com/v1/websocket');

                this.ws.on('open', () => {
                    this.isConnected = true;
                    // 3. Authenticate the WebSocket connection using the acquired token
                    this.ws?.send(`authorize\n1\n\n${this.accessToken}`);
                    console.log("🟢 [TradovateBroker] - WebSocket Connected and Authorized.");
                    
                    // Keep-alive heartbeat loop
                    setInterval(() => {
                        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                            this.ws.send('[]'); 
                        }
                    }, 2500);

                    resolve(true);
                });

                this.ws.on('error', (err) => {
                    console.error("🔴 [TradovateBroker] - WebSocket Error:", err);
                    resolve(false);
                });
            });

        } catch (error: any) {
            console.error("🔴 [TradovateBroker] - Failed to authenticate:", error.response?.data || error.message);
            return false;
        }
    }

    // ─── Market Data (WebSocket) ───────────────────────────────────────

    public subscribeMarketData(symbol: string, onTick: (tick: Tick) => void): void {
        if (!this.isConnected || !this.ws) return;

        console.log(`📡 [TradovateBroker] - Subscribing to Level 1 Ticks for ${symbol}...`);
        this.ws.send(`md/subscribeQuote\n2\n\n{"symbol":"${symbol}"}`);

        this.ws.on('message', (data: WebSocket.RawData) => {
            const message = data.toString();
            // console.log(message); // Uncomment to debug raw websocket frames

            try {
                if (message.startsWith('a')) {
                    const payload = JSON.parse(message.slice(1));
                    payload.forEach((event: any) => {
                        if (event.e === 'md/quote' && event.d && event.d.entries) {
                            const trade = event.d.entries.Trade;
                            if (trade) {
                                onTick({
                                    price: trade.price,
                                    volume: trade.size,
                                    timestamp: new Date(event.d.timestamp).getTime()
                                });
                            }
                        }
                    });
                }
            } catch (err) {}
        });
    }

    // ─── REST API Methods ──────────────────────────────────────────────

    /**
     * Resolves the primary Tradovate account ID (cached after first call).
     */
    private async getAccountId(): Promise<{ id: number; spec: string }> {
        if (this.accountId !== null) {
            return { id: this.accountId, spec: this.accountSpec };
        }

        await this.refreshTokenIfNeeded();

        const res = await this.withTokenRetry(() =>
            this.axiosInstance.get('/account/list')
        );

        const accounts = res.data;
        if (!accounts || accounts.length === 0) {
            throw new Error('No Tradovate accounts found.');
        }

        this.accountId = accounts[0].id;
        this.accountSpec = accounts[0].name || '';
        console.log(`🔑 [TradovateBroker] - Account resolved: ${this.accountSpec} (ID: ${this.accountId})`);
        return { id: this.accountId!, spec: this.accountSpec };
    }

    /**
     * Places a live Tradovate OSO Bracket Order via REST.
     *
     * The bracket consists of:
     *   - Parent: Market order entry (immediate fill)
     *   - Bracket 1 (SL): Stop order at stopPrice
     *   - Bracket 2 (TP): Limit order at targetPrice
     *
     * Both brackets fire opposite actions to close the position.
     *
     * @param symbol   - Tradovate contract symbol (e.g., 'MESM6')
     * @param action   - 'Buy' or 'Sell' (Tradovate format, capitalized)
     * @param qty      - Number of contracts
     * @param tpPrice  - Take Profit price
     * @param slPrice  - Stop Loss price
     */
    public async placeBracketOrder(
        symbol: string,
        action: 'Buy' | 'Sell',
        qty: number,
        tpPrice: number,
        slPrice: number,
    ): Promise<string> {
        await this.refreshTokenIfNeeded();

        const { id: accountId, spec: accountSpec } = await this.getAccountId();
        const exitAction = action === 'Buy' ? 'Sell' : 'Buy';

        const payload = {
            accountSpec,
            accountId,
            action,
            symbol,
            orderQty: qty,
            orderType: 'Market',    // Immediate entry
            isAutomated: true,      // Algorithmic flag required by Tradovate
            bracket1: {
                action: exitAction,
                orderType: 'Stop',
                stopPrice: slPrice,
            },
            bracket2: {
                action: exitAction,
                orderType: 'Limit',
                price: tpPrice,
            },
        };

        try {
            console.log(`⚡ [TradovateBroker] - Sending OSO Bracket: ${action} ${qty}x ${symbol} | TP: ${tpPrice} | SL: ${slPrice}`);

            const response = await this.withTokenRetry(() =>
                this.axiosInstance.post('/order/placeOSO', payload, {
                    timeout: 5000, // 5-second timeout for order placement
                })
            );

            const orderId = response.data?.orderId || response.data?.id || `OSO_${Date.now()}`;
            console.log(`✅ [TradovateBroker] - Bracket PLACED. Order ID: ${orderId}`);
            return String(orderId);

        } catch (error: any) {
            const errMsg = error.response?.data?.errorText || error.response?.data || error.message;
            console.error(`🔴 [TradovateBroker] - Bracket order FAILED:`, errMsg);
            throw new Error(`Bracket order failed: ${errMsg}`);
        }
    }

    /**
     * Fetches the real cash balance from the Tradovate REST API.
     * Used by the SessionLedger for initial sync and background reconciliation.
     */
    public async getCashBalance(): Promise<number> {
        try {
            await this.refreshTokenIfNeeded();

            const { id: accountId } = await this.getAccountId();

            const balanceRes = await this.withTokenRetry(() =>
                this.axiosInstance.get('/cashBalance/getCashBalanceSnapshot', {
                    params: { accountId },
                })
            );

            const balance = balanceRes.data?.totalCashValue ?? balanceRes.data?.cashBalance ?? 0;
            return balance;

        } catch (error: any) {
            console.error('🔴 [TradovateBroker] - Failed to fetch cash balance:', error.message);
            return 0;
        }
    }
}
