import { TradovateBroker } from '../brokers/TradovateBroker';
import { ExecutionEngine } from './ExecutionEngine';
import { Candle } from '../market/CandleAggregator';

/**
 * ActiveTradeMonitor — Institutional Active Position Management
 *
 * Replaces the retail "Set and Forget" bracket model with continuous
 * monitoring while a position is open. Runs 4 independent systems:
 *
 *   System 1: Naked Position Failsafe (5s polling loop)
 *     — Detects dropped bracket stops and injects smart protective orders
 *
 *   System 2: Structural Invalidation (per confirmed candle)
 *     — Exits early if opposing SMC structure confirms against the trade
 *
 *   System 3: Momentum Exhaustion & Time Decay (per confirmed candle)
 *     — Scratches dead trades after 8 candles with no follow-through
 *     — Detects 3-candle volume decline as exhaustion
 *
 *   System 4: Choke Hold Dynamic Trailing Stop (triggered by System 3)
 *     — Tightens the resting stop to 3 points behind market on exhaustion
 *
 * Lifecycle:
 *   start()            → Called after executeBracket() succeeds
 *   onCandleComplete() → Called on each 1M candle while position is active
 *   stop()             → Called on position close (any exit path)
 */

// ==========================================
// Types
// ==========================================

export interface MonitorContext {
    symbol: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    hardStopPrice: number;      // Original SL from bracket (entry ± 20pts)
    qty: number;                // Number of contracts
}

/** Callback signature for the monitor to notify MoMEngine of a position close */
export type OnMonitorFlatten = (reason: string) => Promise<void>;

// ==========================================
// Constants
// ==========================================

/** Naked position failsafe polling interval */
const FAILSAFE_POLL_MS = 5000;

/** Points of profit required to trigger profit-protecting stop (vs hard stop) */
const PROFIT_THRESHOLD_POINTS = 10;

/** Points behind market price for the profit-protecting failsafe stop */
const FAILSAFE_TRAIL_POINTS = 5;

/** Number of candles with no momentum before scratching the trade */
const TIME_DECAY_CANDLES = 8;

/** Price tolerance for "flat" PnL in points (≈ 2 ticks on MES) */
const FLAT_TOLERANCE_POINTS = 0.50;

/** Consecutive declining volume candles to trigger exhaustion */
const VOLUME_DECLINE_COUNT = 3;

/** Points behind market for the Choke Hold tight stop */
const CHOKE_DISTANCE_POINTS = 3;

export class ActiveTradeMonitor {
    private broker: TradovateBroker;
    private executionEngine: ExecutionEngine;
    private onFlatten: OnMonitorFlatten;

    // --- Active Context ---
    private ctx: MonitorContext | null = null;
    private isActive: boolean = false;

    // --- System 1: Failsafe Polling ---
    private failsafeInterval: ReturnType<typeof setInterval> | null = null;
    private failsafeInjected: boolean = false; // Prevent duplicate injections per cycle

    // --- System 3: Time Decay & Volume Tracking ---
    private candlesSinceEntry: number = 0;
    private volumeHistory: number[] = [];

    // --- System 4: Choke Hold ---
    private isChokeActive: boolean = false;

    // --- Last known price (updated per candle) ---
    private lastPrice: number = 0;

    // --- Guard: prevent re-entrant flatten calls ---
    private isFlattenInProgress: boolean = false;

    constructor(
        broker: TradovateBroker,
        executionEngine: ExecutionEngine,
        onFlatten: OnMonitorFlatten,
    ) {
        this.broker = broker;
        this.executionEngine = executionEngine;
        this.onFlatten = onFlatten;
    }

    // ==========================================
    // LIFECYCLE
    // ==========================================

    /**
     * Activates the monitor after a position is opened.
     * Starts the 5-second Naked Position Failsafe polling loop.
     */
    public start(ctx: MonitorContext): void {
        this.ctx = ctx;
        this.isActive = true;
        this.lastPrice = ctx.entryPrice;
        this.candlesSinceEntry = 0;
        this.volumeHistory = [];
        this.isChokeActive = false;
        this.failsafeInjected = false;
        this.isFlattenInProgress = false;

        console.log(
            `🎯 [MONITOR] - Active Trade Monitor ONLINE.` +
            ` | ${ctx.side} ${ctx.qty}x ${ctx.symbol} @ ${ctx.entryPrice}` +
            ` | Hard Stop: ${ctx.hardStopPrice}`
        );

        // System 1: Start the naked position failsafe polling
        this.failsafeInterval = setInterval(() => this.runFailsafe(), FAILSAFE_POLL_MS);
    }

    /**
     * Deactivates the monitor when a position is closed (any exit path).
     * Clears all timers and resets state.
     */
    public stop(): void {
        if (this.failsafeInterval) {
            clearInterval(this.failsafeInterval);
            this.failsafeInterval = null;
        }

        if (this.isActive) {
            console.log(`🎯 [MONITOR] - Active Trade Monitor OFFLINE.`);
        }

        this.ctx = null;
        this.isActive = false;
        this.candlesSinceEntry = 0;
        this.volumeHistory = [];
        this.isChokeActive = false;
        this.failsafeInjected = false;
        this.isFlattenInProgress = false;
    }

    /**
     * Returns whether the monitor is currently tracking a position.
     */
    public isMonitoring(): boolean {
        return this.isActive && this.ctx !== null;
    }

    // ==========================================
    // CANDLE-DRIVEN CHECKS (Systems 2, 3, 4)
    // ==========================================

    /**
     * Called by MoMEngine on each completed 1-minute candle while a position is active.
     * Runs the candle-based monitoring systems in priority order.
     *
     * @param candle - The completed 1M candle
     * @param signal - The SMC signal from the current candle ('BUY' | 'SELL' | 'HOLD')
     */
    public async onCandleComplete(
        candle: Candle,
        signal: 'BUY' | 'SELL' | 'HOLD',
    ): Promise<void> {
        if (!this.isActive || !this.ctx || this.isFlattenInProgress) return;

        // Update last known price
        this.lastPrice = candle.close;
        this.candlesSinceEntry++;
        this.volumeHistory.push(candle.volume);

        // Calculate current profit in points
        const profitPoints = this.ctx.side === 'BUY'
            ? candle.close - this.ctx.entryPrice
            : this.ctx.entryPrice - candle.close;

        // --- System 2: Structural Invalidation (highest priority) ---
        if (this.checkStructuralInvalidation(signal)) {
            await this.triggerFlatten('Thesis invalidated by confirmed opposing structure');
            return;
        }

        // --- System 3: Time Decay ---
        if (this.checkTimeDecay(profitPoints)) {
            await this.triggerFlatten(`Time decay — ${this.candlesSinceEntry} candles with no momentum`);
            return;
        }

        // --- System 3b: Momentum Exhaustion (volume decline) ---
        const isExhausted = this.checkVolumeExhaustion();
        if (isExhausted) {
            if (profitPoints <= 0) {
                await this.triggerFlatten('Volume exhaustion with negative PnL');
                return;
            }

            // --- System 4: Choke Hold (exhaustion while in profit) ---
            await this.engageChokeHold(candle.close, profitPoints);
        }
    }

    // ==========================================
    // SYSTEM 1: Naked Position Failsafe (5s poll)
    // ==========================================

    /**
     * Polls broker every 5 seconds to detect positions left without stop protection.
     * If net position exists but no working stop orders → inject a smart protective stop.
     */
    private async runFailsafe(): Promise<void> {
        if (!this.isActive || !this.ctx || this.isFlattenInProgress) return;

        try {
            // 1. Check net position — if flat, position was closed externally
            const netPos = await this.broker.getNetPositionQty(this.ctx.symbol);

            if (netPos === 0) {
                // Position was closed by bracket fill — notify MoMEngine
                console.log(`✅ [MONITOR] - Failsafe detected flat position. Brackets filled externally.`);
                await this.triggerFlatten('Brackets filled (position flat)');
                return;
            }

            // 2. Check for working stop orders
            const stopCount = await this.broker.getWorkingStopOrders(this.ctx.symbol);

            // If query failed (returns -1), do not act — avoid false positives
            if (stopCount < 0) return;

            // If stops exist, position is protected — reset injection flag
            if (stopCount > 0) {
                this.failsafeInjected = false;
                return;
            }

            // 3. NAKED POSITION DETECTED — inject smart protective stop
            if (this.failsafeInjected) return; // Already injected this cycle, wait for it to register

            const profitPoints = this.ctx.side === 'BUY'
                ? this.lastPrice - this.ctx.entryPrice
                : this.ctx.entryPrice - this.lastPrice;

            let stopPrice: number;
            let stopReason: string;

            if (profitPoints >= PROFIT_THRESHOLD_POINTS) {
                // Deep in profit → place stop 5 points behind market (locks in profit)
                stopPrice = this.ctx.side === 'BUY'
                    ? this.lastPrice - FAILSAFE_TRAIL_POINTS
                    : this.lastPrice + FAILSAFE_TRAIL_POINTS;
                stopReason = `profit-protecting (${profitPoints.toFixed(1)}pts in green, stop ${FAILSAFE_TRAIL_POINTS}pts behind)`;
            } else {
                // Drawdown or near breakeven → place stop at original hard stop
                stopPrice = this.ctx.hardStopPrice;
                stopReason = `hard stop restoration (${profitPoints.toFixed(1)}pts from entry)`;
            }

            const exitAction: 'Buy' | 'Sell' = this.ctx.side === 'BUY' ? 'Sell' : 'Buy';
            const qty = Math.abs(netPos); // Use actual broker position size

            console.log(`🛡️ [FAILSAFE] - Naked position detected! Net: ${netPos} | Stops: ${stopCount} | Injecting ${stopReason}`);

            await this.broker.placeProtectiveStop(
                this.ctx.symbol,
                exitAction,
                qty,
                stopPrice,
            );

            this.failsafeInjected = true; // Prevent duplicate injections until stops re-register

            console.log(`🛡️ [FAILSAFE] - Protective stop injected at $${stopPrice}. Position secured.`);

        } catch (error: any) {
            // Silent fail — don't crash the polling loop
            console.error(`🔴 [MONITOR] - Failsafe poll error:`, error.message);
        }
    }

    // ==========================================
    // SYSTEM 2: Structural Invalidation
    // ==========================================

    /**
     * Checks if the latest confirmed candle produced an opposing structural signal.
     * Only acts on confirmed BUY/SELL signals — HOLD is ignored.
     *
     * @param signal - The SMC signal from the current completed candle
     * @returns true if the trade thesis is invalidated
     */
    private checkStructuralInvalidation(signal: 'BUY' | 'SELL' | 'HOLD'): boolean {
        if (!this.ctx || signal === 'HOLD') return false;

        // Long position but bearish structure confirmed
        if (this.ctx.side === 'BUY' && signal === 'SELL') {
            console.log(`🔄 [MONITOR] - STRUCTURAL INVALIDATION: Long position, but confirmed Bearish ChoCh/FVG detected.`);
            return true;
        }

        // Short position but bullish structure confirmed
        if (this.ctx.side === 'SELL' && signal === 'BUY') {
            console.log(`🔄 [MONITOR] - STRUCTURAL INVALIDATION: Short position, but confirmed Bullish ChoCh/FVG detected.`);
            return true;
        }

        return false;
    }

    // ==========================================
    // SYSTEM 3: Momentum Exhaustion & Time Decay
    // ==========================================

    /**
     * Time Decay: If the trade has been open > 8 candles with flat/negative PnL,
     * the momentum thesis has failed.
     *
     * @param profitPoints - Current unrealized profit in index points
     * @returns true if the trade should be scratched
     */
    private checkTimeDecay(profitPoints: number): boolean {
        if (this.candlesSinceEntry <= TIME_DECAY_CANDLES) return false;

        if (profitPoints <= FLAT_TOLERANCE_POINTS) {
            console.log(
                `⏰ [MONITOR] - TIME DECAY: ${this.candlesSinceEntry} candles elapsed.` +
                ` PnL: ${profitPoints.toFixed(2)}pts (threshold: ${FLAT_TOLERANCE_POINTS}pts). Momentum dead.`
            );
            return true;
        }

        return false;
    }

    /**
     * Volume Exhaustion: If volume decreases for 3 consecutive candles,
     * momentum is dying.
     *
     * @returns true if volume exhaustion is detected
     */
    private checkVolumeExhaustion(): boolean {
        if (this.volumeHistory.length < VOLUME_DECLINE_COUNT) return false;

        const len = this.volumeHistory.length;
        let declining = true;

        for (let i = len - VOLUME_DECLINE_COUNT + 1; i < len; i++) {
            if (this.volumeHistory[i] >= this.volumeHistory[i - 1]) {
                declining = false;
                break;
            }
        }

        if (declining) {
            const recentVols = this.volumeHistory.slice(-VOLUME_DECLINE_COUNT).map(v => Math.round(v));
            console.log(`📉 [MONITOR] - VOLUME EXHAUSTION: ${VOLUME_DECLINE_COUNT} consecutive declining candles [${recentVols.join(' → ')}]`);
        }

        return declining;
    }

    // ==========================================
    // SYSTEM 4: Choke Hold Dynamic Trailing Stop
    // ==========================================

    /**
     * Tightens the resting stop to 3 points behind the current market price.
     * Only engages when the trade is in profit and volume exhaustion is detected.
     *
     * @param currentPrice  - The latest candle close
     * @param profitPoints  - Current unrealized profit in index points
     */
    private async engageChokeHold(currentPrice: number, profitPoints: number): Promise<void> {
        if (!this.ctx) return;

        const exitAction: 'Buy' | 'Sell' = this.ctx.side === 'BUY' ? 'Sell' : 'Buy';

        // Calculate tight stop 3 points behind market
        let tightStop = this.ctx.side === 'BUY'
            ? currentPrice - CHOKE_DISTANCE_POINTS
            : currentPrice + CHOKE_DISTANCE_POINTS;

        // Ensure the choke stop locks in profit (must be better than entry)
        const locksProfit = this.ctx.side === 'BUY'
            ? tightStop > this.ctx.entryPrice
            : tightStop < this.ctx.entryPrice;

        if (!locksProfit) {
            // Not enough profit to lock — fall back to breakeven + 0.25
            tightStop = this.ctx.side === 'BUY'
                ? this.ctx.entryPrice + 0.25
                : this.ctx.entryPrice - 0.25;
            console.log(`🤏 [MONITOR] - Choke Hold: Insufficient profit for 3pt trail. Using breakeven stop @ $${tightStop}`);
        }

        const chokeLabel = this.isChokeActive ? 'TIGHTENED' : 'ENGAGED';
        console.log(
            `🤏 [MONITOR] - Choke Hold ${chokeLabel}: Stop → $${tightStop}` +
            ` (${CHOKE_DISTANCE_POINTS}pts behind market @ $${currentPrice})` +
            ` | Profit: ${profitPoints.toFixed(1)}pts`
        );

        const success = await this.broker.modifyOrReplaceStop(
            this.ctx.symbol,
            exitAction,
            this.ctx.qty,
            tightStop,
        );

        if (success) {
            this.isChokeActive = true;
        } else {
            console.error(`🔴 [MONITOR] - Choke Hold failed to move stop. Will retry next candle.`);
        }
    }

    // ==========================================
    // FLATTEN TRIGGER
    // ==========================================

    /**
     * Centralized flatten handler. Ensures only one flatten executes at a time.
     * Calls ExecutionEngine.flattenPosition() then notifies MoMEngine via callback.
     *
     * CRITICAL: Does NOT fire an opposite trade. The standard gate pipeline
     * will require a fresh pullback/retest into a new FVG — inherently preventing revenge.
     *
     * @param reason - Human-readable reason for the flatten (logged)
     */
    private async triggerFlatten(reason: string): Promise<void> {
        if (!this.ctx || this.isFlattenInProgress) return;
        this.isFlattenInProgress = true;

        console.log(`🔄 [MONITOR] - ${reason}. Exiting early.`);

        try {
            // Flatten via ExecutionEngine (cancel brackets + market close)
            await this.executionEngine.flattenPosition(this.ctx.symbol);
        } catch (error: any) {
            console.error(`🔴 [MONITOR] - Flatten execution failed:`, error.message);
        }

        // Notify MoMEngine to clean up local state (ledger, risk engine, activePosition)
        try {
            await this.onFlatten(reason);
        } catch (error: any) {
            console.error(`🔴 [MONITOR] - onFlatten callback failed:`, error.message);
        }

        // Stop the monitor
        this.stop();
    }
}
