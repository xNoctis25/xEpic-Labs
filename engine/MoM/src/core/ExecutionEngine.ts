export class ExecutionEngine {
    private activeOrders: Map<string, any> = new Map();
    private ORDER_TTL_MS = 10000; // 10-second Time-To-Live to avoid slippage

    public placeLimitOrder(symbol: string, price: number, side: 'BUY' | 'SELL', qty: number): string {
        const orderId = `ORD_${Date.now()}`;
        console.log(`⚡ [ExecutionEngine] - Placing ${side} Limit Order for ${qty}x ${symbol} @ $${price}`);
        
        const order = { orderId, symbol, price, side, qty, timestamp: Date.now() };
        this.activeOrders.set(orderId, order);

        // 10-Second TTL Slippage Protection
        setTimeout(() => {
            if (this.activeOrders.has(orderId)) {
                console.log(`⌛ [ExecutionEngine] - Order ${orderId} TTL Expired (10s). Cancelling to prevent slippage.`);
                this.cancelOrder(orderId);
            }
        }, this.ORDER_TTL_MS);

        return orderId;
    }

    public cancelOrder(orderId: string): void {
        if (this.activeOrders.has(orderId)) {
            this.activeOrders.delete(orderId);
            console.log(`❌ [ExecutionEngine] - Order ${orderId} Cancelled.`);
        }
    }

    public onOrderFilled(orderId: string): void {
        if (this.activeOrders.has(orderId)) {
            console.log(`✅ [ExecutionEngine] - Order ${orderId} FILLED.`);
            this.activeOrders.delete(orderId);
        }
    }
}
