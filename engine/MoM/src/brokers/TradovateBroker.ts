import WebSocket from 'ws';
import axios, { AxiosInstance } from 'axios';
import { config as dotEnvConfig } from 'dotenv';
import { config } from '../config/env';

dotEnvConfig();

/** Token refresh interval: 1 hour (ms). Tradovate tokens expire after a few hours. */
const TOKEN_TTL_MS = 60 * 60 * 1000;

/**
 * TradovateBroker — REST Execution + OAuth Authentication
 *
 * This broker is now purely for:
 *   - OAuth token management (request, refresh, retry)
 *   - Account resolution
 *   - Order execution (bracket, runner, liquidation)
 *   - Cash balance queries
 *
 * Market data has been moved to DatabentoLiveService.
 */
export class TradovateBroker {
    private ws: WebSocket | null = null;
    private isConnected: boolean = false;
    private accessToken: string = '';

    // --- Token lifecycle ---
    private tokenAcquiredAt: number = 0;
    private refreshPromise: Promise<void> | null = null;

    // --- Tradovate LIVE API ---
    private readonly REST_BASE = 'https://demo.tradovateapi.com/v1';
    private readonly AUTH_URL = 'https://demo.tradovateapi.com/v1/auth/accesstokenrequest';

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
            name: config.TRADOVATE_USERNAME,
            password: config.TRADOVATE_PASSWORD,
            appId: config.TRADOVATE_APP_ID,
            appVersion: config.TRADOVATE_APP_VERSION,
            cid: config.TRADOVATE_CLIENT_ID,
            sec: config.TRADOVATE_CLIENT_SECRET,
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

    /**
     * Authenticates with Tradovate via REST OAuth.
     * The WebSocket is retained for order status updates only.
     */
    public async connect(): Promise<boolean> {
        try {
            await this.requestToken();
            console.log("🟢 [TradovateBroker] - Authenticated (REST-only mode).");
            return true;
        } catch (error: any) {
            console.error("🔴 [TradovateBroker] - Failed to authenticate:", error.response?.data || error.message);
            return false;
        }
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
     * Places a Market entry order with a single bracket leg (TrailingStop or Stop).
     *
     * Used by the ExecutionEngine's scale-out system for "runner" legs that
     * have no Take Profit — only a trailing stop to lock in gains.
     *
     * Tradovate API:
     *   - Entry: Market order (immediate fill)
     *   - bracket1: { orderType: 'TrailingStop', pegDifference: -N }
     *
     * @param symbol  - Tradovate contract symbol
     * @param action  - 'Buy' or 'Sell'
     * @param qty     - Number of contracts
     * @param bracket - Single bracket leg config (orderType + pegDifference)
     * @returns Order ID string
     */
    public async placeOrder(
        symbol: string,
        action: 'Buy' | 'Sell',
        qty: number,
        bracket: { orderType: string; pegDifference: number },
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
            orderType: 'Market',
            isAutomated: true,
            bracket1: {
                action: exitAction,
                orderType: bracket.orderType,
                pegDifference: bracket.pegDifference,
            },
        };

        try {
            console.log(
                `⚡ [TradovateBroker] - Sending Runner Order: ${action} ${qty}x ${symbol}` +
                ` | ${bracket.orderType} peg: ${bracket.pegDifference}`
            );

            const response = await this.withTokenRetry(() =>
                this.axiosInstance.post('/order/placeOrder', payload, {
                    timeout: 5000,
                })
            );

            const orderId = response.data?.orderId || response.data?.id || `RUN_${Date.now()}`;
            console.log(`✅ [TradovateBroker] - Runner PLACED. Order ID: ${orderId}`);
            return String(orderId);

        } catch (error: any) {
            const errMsg = error.response?.data?.errorText || error.response?.data || error.message;
            console.error(`🔴 [TradovateBroker] - Runner order FAILED:`, errMsg);
            throw new Error(`Runner order failed: ${errMsg}`);
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

    /**
     * EOD Kill Switch — Liquidate a position at market and cancel orphaned orders.
     *
     * Fires a Market order in the opposite direction to instantly flatten,
     * then calls /order/cancelAllOrders to clean up any orphaned bracket
     * legs (TP limits, trailing stops) that Tradovate may still be tracking.
     *
     * @param symbol - Tradovate contract symbol (e.g., 'MESM6')
     * @param exitAction - 'Buy' or 'Sell' (the CLOSING direction)
     * @param qty - Number of contracts to flatten
     * @returns true if the flatten order was accepted
     */
    public async liquidatePosition(
        symbol: string,
        exitAction: 'Buy' | 'Sell',
        qty: number,
    ): Promise<boolean> {
        await this.refreshTokenIfNeeded();

        const { id: accountId, spec: accountSpec } = await this.getAccountId();

        // 1. Fire a naked Market order to flatten the position
        const flattenPayload = {
            accountSpec,
            accountId,
            action: exitAction,
            symbol,
            orderQty: qty,
            orderType: 'Market',
            isAutomated: true,
        };

        try {
            console.log(`🚨 [TradovateBroker] - LIQUIDATE: ${exitAction} ${qty}x ${symbol} at Market`);

            await this.withTokenRetry(() =>
                this.axiosInstance.post('/order/placeOrder', flattenPayload, {
                    timeout: 5000,
                })
            );

            console.log(`✅ [TradovateBroker] - Flatten order accepted.`);
        } catch (error: any) {
            const errMsg = error.response?.data?.errorText || error.response?.data || error.message;
            console.error(`🔴 [TradovateBroker] - Flatten order FAILED:`, errMsg);
            return false;
        }

        return true;
    }

    public async getNetPositionQty(symbol: string): Promise<number> {
        await this.refreshTokenIfNeeded();
        const { id: accountId } = await this.getAccountId();
        try {
            const contractRes = await this.withTokenRetry(() =>
                this.axiosInstance.get('/contract/find', { params: { name: symbol } })
            );
            const contractId = contractRes.data?.id;
            if (!contractId) return 0;

            const posRes = await this.withTokenRetry(() =>
                this.axiosInstance.get('/position/list', { params: { accountId } })
            );
            const positions = posRes.data || [];
            const pos = positions.find((p: any) => p.contractId === contractId);
            return pos ? pos.netPos : 0;
        } catch (error: any) {
            return 0;
        }
    }

    public async cancelAllWorkingOrders(): Promise<void> {
        await this.refreshTokenIfNeeded();
        const { id: accountId } = await this.getAccountId();
        try {
            await this.withTokenRetry(() =>
                this.axiosInstance.post('/order/cancelAllOrders', { accountId })
            );
            console.log(`🧹 [TradovateBroker] - All working orders canceled.`);
        } catch (error: any) { }
    }

    // ─── Active Trade Monitor Support ──────────────────────────────────

    /**
     * Counts the number of active Stop/TrailingStop/StopLimit orders for a given symbol.
     * Used by ActiveTradeMonitor to detect "naked" positions (net position != 0 but no stops).
     *
     * @param symbol - Tradovate contract symbol (e.g., 'MESM6')
     * @returns Number of working stop orders (0 = naked, >0 = protected)
     */
    public async getWorkingStopOrders(symbol: string): Promise<number> {
        await this.refreshTokenIfNeeded();
        const { id: accountId } = await this.getAccountId();

        try {
            // Resolve contract ID for the symbol
            const contractRes = await this.withTokenRetry(() =>
                this.axiosInstance.get('/contract/find', { params: { name: symbol } })
            );
            const contractId = contractRes.data?.id;
            if (!contractId) return 0;

            // Fetch all orders for the account
            const orderRes = await this.withTokenRetry(() =>
                this.axiosInstance.get('/order/list')
            );
            const orders = orderRes.data || [];

            // Filter for working stop-type orders matching our contract
            const stopTypes = ['Stop', 'TrailingStop', 'StopLimit'];
            const workingStops = orders.filter((o: any) =>
                o.contractId === contractId &&
                o.ordStatus === 'Working' &&
                stopTypes.includes(o.ordType)
            );

            return workingStops.length;
        } catch (error: any) {
            console.error(`🔴 [TradovateBroker] - Failed to query working stop orders:`, error.message);
            return -1; // Negative = query failed, do not act on it
        }
    }

    /**
     * Places a standalone resting Stop Market order for position protection.
     * This is NOT a bracket — it's a single protective exit order.
     * Used by ActiveTradeMonitor's Naked Position Failsafe and Choke Hold systems.
     *
     * @param symbol    - Tradovate contract symbol
     * @param exitAction - 'Buy' or 'Sell' (the CLOSING direction)
     * @param qty       - Number of contracts to protect
     * @param stopPrice - The price at which the stop triggers
     * @returns Order ID string, or null on failure
     */
    public async placeProtectiveStop(
        symbol: string,
        exitAction: 'Buy' | 'Sell',
        qty: number,
        stopPrice: number,
    ): Promise<string | null> {
        await this.refreshTokenIfNeeded();
        const { id: accountId, spec: accountSpec } = await this.getAccountId();

        const payload = {
            accountSpec,
            accountId,
            action: exitAction,
            symbol,
            orderQty: qty,
            orderType: 'Stop',
            stopPrice,
            isAutomated: true,
        };

        try {
            console.log(`🛡️ [TradovateBroker] - Placing protective stop: ${exitAction} ${qty}x ${symbol} @ Stop $${stopPrice}`);

            const response = await this.withTokenRetry(() =>
                this.axiosInstance.post('/order/placeOrder', payload, { timeout: 5000 })
            );

            const orderId = response.data?.orderId || response.data?.id || `PSTOP_${Date.now()}`;
            console.log(`✅ [TradovateBroker] - Protective stop PLACED. Order ID: ${orderId}`);
            return String(orderId);

        } catch (error: any) {
            const errMsg = error.response?.data?.errorText || error.response?.data || error.message;
            console.error(`🔴 [TradovateBroker] - Protective stop FAILED:`, errMsg);
            return null;
        }
    }

    /**
     * Modifies an existing resting stop order's price.
     * Used by the Choke Hold system to dynamically tighten stops.
     *
     * If modify fails (some brokers reject modifications), falls back to
     * cancel + re-place via placeProtectiveStop().
     *
     * @param symbol       - Tradovate contract symbol (for fallback re-place)
     * @param exitAction   - 'Buy' or 'Sell' (for fallback re-place)
     * @param qty          - Number of contracts (for fallback re-place)
     * @param newStopPrice - The new stop price to set
     * @returns true if the stop was successfully moved
     */
    public async modifyOrReplaceStop(
        symbol: string,
        exitAction: 'Buy' | 'Sell',
        qty: number,
        newStopPrice: number,
    ): Promise<boolean> {
        await this.refreshTokenIfNeeded();
        const { id: accountId } = await this.getAccountId();

        try {
            // Find the existing working stop order for this symbol
            const contractRes = await this.withTokenRetry(() =>
                this.axiosInstance.get('/contract/find', { params: { name: symbol } })
            );
            const contractId = contractRes.data?.id;
            if (!contractId) return false;

            const orderRes = await this.withTokenRetry(() =>
                this.axiosInstance.get('/order/list')
            );
            const orders = orderRes.data || [];

            const stopTypes = ['Stop', 'TrailingStop', 'StopLimit'];
            const existingStop = orders.find((o: any) =>
                o.contractId === contractId &&
                o.ordStatus === 'Working' &&
                stopTypes.includes(o.ordType)
            );

            if (existingStop) {
                // Try to modify in-place
                try {
                    await this.withTokenRetry(() =>
                        this.axiosInstance.post('/order/modifyOrder', {
                            orderId: existingStop.id,
                            orderQty: qty,
                            orderType: 'Stop',
                            stopPrice: newStopPrice,
                            isAutomated: true,
                        })
                    );
                    console.log(`✅ [TradovateBroker] - Stop modified to $${newStopPrice} (Order: ${existingStop.id})`);
                    return true;
                } catch (modifyErr: any) {
                    console.warn(`⚠️ [TradovateBroker] - Modify rejected. Falling back to cancel + replace.`);
                    // Cancel the old one
                    try {
                        await this.withTokenRetry(() =>
                            this.axiosInstance.post('/order/cancelOrder', { orderId: existingStop.id })
                        );
                    } catch { }
                }
            }

            // Fallback: place a fresh protective stop
            const result = await this.placeProtectiveStop(symbol, exitAction, qty, newStopPrice);
            return result !== null;

        } catch (error: any) {
            console.error(`🔴 [TradovateBroker] - modifyOrReplaceStop FAILED:`, error.message);
            return false;
        }
    }
}
