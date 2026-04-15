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

    public executeMarketOrder(symbol: string, qty: number, side: 'BUY' | 'SELL'): string {
        const orderId = `TV_${Date.now()}`;
        console.log(`⚡ [TradovateBroker] - Simulated ${side} MARKET Order for ${qty}x ${symbol} executed.`);
        return orderId;
    }
}
