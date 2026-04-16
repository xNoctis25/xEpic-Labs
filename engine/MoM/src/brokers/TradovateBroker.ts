import WebSocket from 'ws';
import axios from 'axios';
import { config as dotEnvConfig } from 'dotenv';
import { Tick } from '../market/CandleAggregator';

dotEnvConfig();

export class TradovateBroker {
    private ws: WebSocket | null = null;
    private isConnected: boolean = false;
    private accessToken: string = '';

    public async connect(): Promise<boolean> {
        console.log("🔐 [TradovateBroker] - Requesting OAuth Access Token...");
        
        try {
            // 1. Get the OAuth Token via REST
            const response = await axios.post('https://demo.tradovateapi.com/v1/auth/accesstokenrequest', {
                name: process.env.TRADOVATE_USERNAME,
                password: process.env.TRADOVATE_PASSWORD,
                appId: process.env.TRADOVATE_APP_ID,
                appVersion: process.env.TRADOVATE_APP_VERSION,
                cid: process.env.TRADOVATE_CLIENT_ID,
                sec: process.env.TRADOVATE_CLIENT_SECRET
            });

            this.accessToken = response.data.accessToken;
            console.log("✅ [TradovateBroker] - OAuth Token Acquired. Initializing WebSocket...");

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
    // --- Tradovate REST API Base URL ---
    // Switch to 'https://live.tradovateapi.com/v1' for production
    private readonly REST_BASE = 'https://demo.tradovateapi.com/v1';

    // Cached account ID (resolved once on first use)
    private accountId: number | null = null;
    private accountSpec: string = '';

    /**
     * Resolves the primary Tradovate account ID (cached after first call).
     */
    private async getAccountId(): Promise<{ id: number; spec: string }> {
        if (this.accountId !== null) {
            return { id: this.accountId, spec: this.accountSpec };
        }

        const res = await axios.get(`${this.REST_BASE}/account/list`, {
            headers: { Authorization: `Bearer ${this.accessToken}` },
        });

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

            const response = await axios.post(`${this.REST_BASE}/order/placeOSO`, payload, {
                headers: {
                    Authorization: `Bearer ${this.accessToken}`,
                    'Content-Type': 'application/json',
                },
                timeout: 5000, // 5-second timeout for order placement
            });

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
            const { id: accountId } = await this.getAccountId();

            const balanceRes = await axios.get(
                `${this.REST_BASE}/cashBalance/getCashBalanceSnapshot`, {
                    params: { accountId },
                    headers: { Authorization: `Bearer ${this.accessToken}` },
                }
            );

            const balance = balanceRes.data?.totalCashValue ?? balanceRes.data?.cashBalance ?? 0;
            return balance;

        } catch (error: any) {
            console.error('🔴 [TradovateBroker] - Failed to fetch cash balance:', error.message);
            return 0;
        }
    }
}

