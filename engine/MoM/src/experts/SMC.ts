import { Candle } from '../market/CandleAggregator';
import { MarketClock } from '../core/MarketClock';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Snapshot of the SMC's state after each analyze() call.
 * Used by MoMEngine for the verbose heartbeat log.
 */
export interface HeartbeatSnapshot {
    trend: 'Bullish' | 'Bearish' | 'Neutral';
    fvg: 'Bullish FVG' | 'Bearish FVG' | 'None';
    decision: 'BUY' | 'SELL' | 'HOLD';
    activeFvgCount: number;
    atr: number;
}

/** Persistent Fair Value Gap zone stored in the registry. */
export interface FvgZone {
    direction:     'BULLISH' | 'BEARISH';
    top:           number;     // Upper edge of the gap
    bottom:        number;     // Lower edge of the gap
    formationTime: number;     // epoch ms when the FVG was detected
    formationIdx:  number;     // candle index when formed
    isActive:      boolean;    // false once mitigated/invalidated
    vwapConfluence: boolean;   // true if FVG overlaps session VWAP
}

/** Rich signal output from SMC — carries confidence metadata. */
export interface SmcSignal {
    action:     'BUY' | 'SELL' | 'HOLD';
    confidence: number;        // 0-10 confluence score
    fvgZone?:   FvgZone;       // the FVG that triggered the signal (if any)
    reason?:    string;        // human-readable explanation
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const ATR_PERIOD           = 14;           // Rolling ATR lookback
const FVG_GAP_ATR_MULT     = 0.25;         // Min gap = ATR * 0.25
const VOLUME_SPIKE_MULT    = 1.5;          // Displacement candle must be 1.5× median
const VOLUME_OUTLIER_CAP   = 3.0;          // Cap candle volume at 3× median before averaging
const SWING_PIVOT_BARS     = 3;            // 3-bar pivot for swing detection
const MAX_FVG_AGE_CANDLES  = 60;           // Invalidate FVGs older than 60 candles
const MAX_CANDLES           = 100;          // Ring buffer size — trim older candles
const CME_SESSION_RESET_HOUR = 18;         // 6:00 PM ET = CME Globex session open

// ─────────────────────────────────────────────────────────────────────────────
// SMC — Institutional Grade FVG + MSS Signal Engine
// ─────────────────────────────────────────────────────────────────────────────

export class SMC {
    private candles: Candle[] = [];
    private candleCount = 0;   // monotonic counter (survives trimming)

    // --- Persistent FVG Registry ---
    private fvgRegistry: FvgZone[] = [];

    // --- ATR State ---
    private atrValues: number[] = [];
    private currentATR = 0;

    // --- Session VWAP (resets at 6:00 PM ET) ---
    private cumVolPrice = 0;
    private cumVol = 0;
    private currentSessionDay = -1;  // tracks the ET session day

    // --- Setup Rejection Log (clears daily) ---
    public dailyRejectedSetups: string[] = [];
    private rejectionDay = -1;

    // --- Debug Heartbeat Snapshot ---
    public lastHeartbeat: HeartbeatSnapshot = {
        trend: 'Neutral', fvg: 'None', decision: 'HOLD', activeFvgCount: 0, atr: 0,
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Main Analysis — called every 1-minute candle
    // ─────────────────────────────────────────────────────────────────────────

    public analyze(candle: Candle): SmcSignal {
        this.candles.push(candle);
        this.candleCount++;

        // Trim ring buffer
        if (this.candles.length > MAX_CANDLES) {
            this.candles.shift();
        }

        const len = this.candles.length;

        // ── Session VWAP (resets at 6:00 PM ET — CME Globex open) ─────────
        const et = MarketClock.getEasternTime(candle.timestamp);
        const etHour = et.getHours();
        const etDay = et.getDate();

        // Session day changes at 6:00 PM ET
        const sessionDay = etHour >= CME_SESSION_RESET_HOUR ? etDay : etDay - 1;
        if (sessionDay !== this.currentSessionDay) {
            this.cumVolPrice = 0;
            this.cumVol = 0;
            this.currentSessionDay = sessionDay;
        }

        // Clear rejection log on new session
        if (sessionDay !== this.rejectionDay) {
            this.dailyRejectedSetups = [];
            this.rejectionDay = sessionDay;
        }

        const typicalPrice = (candle.high + candle.low + candle.close) / 3;
        this.cumVolPrice += typicalPrice * candle.volume;
        this.cumVol += candle.volume;
        const vwap = this.cumVol > 0 ? this.cumVolPrice / this.cumVol : 0;

        // ── Trend Bias (VWAP-relative) ────────────────────────────────────
        let trend: HeartbeatSnapshot['trend'] = 'Neutral';
        if (vwap > 0) {
            trend = candle.close > vwap ? 'Bullish' : candle.close < vwap ? 'Bearish' : 'Neutral';
        }

        // ── ATR-14 Calculation ────────────────────────────────────────────
        if (len >= 2) {
            const prev = this.candles[len - 2];
            const tr = Math.max(
                candle.high - candle.low,
                Math.abs(candle.high - prev.close),
                Math.abs(candle.low - prev.close),
            );
            this.atrValues.push(tr);
            if (this.atrValues.length > ATR_PERIOD) this.atrValues.shift();
            this.currentATR = this.atrValues.reduce((a, b) => a + b, 0) / this.atrValues.length;
        }

        // Default heartbeat
        let fvgLabel: HeartbeatSnapshot['fvg'] = 'None';
        const activeFvgs = this.fvgRegistry.filter(z => z.isActive);

        const holdSignal: SmcSignal = { action: 'HOLD', confidence: 0 };

        // Need enough data for FVG detection (at least 4 candles)
        if (len < 4 || this.currentATR <= 0) {
            this.lastHeartbeat = { trend, fvg: 'None', decision: 'HOLD', activeFvgCount: activeFvgs.length, atr: this.currentATR };
            return holdSignal;
        }

        // ── Step 1: Detect NEW FVGs from the last 3 completed candles ─────
        this.detectNewFvgs(vwap);

        // ── Step 2: Mitigate / Invalidate old FVGs ────────────────────────
        this.updateFvgRegistry(candle);

        // ── Step 3: Scan ALL active FVGs for tap entries ──────────────────
        const signal = this.scanForTapEntry(candle, vwap, trend);

        if (signal) {
            fvgLabel = signal.action === 'BUY' ? 'Bullish FVG' : 'Bearish FVG';
            this.lastHeartbeat = {
                trend, fvg: fvgLabel, decision: signal.action,
                activeFvgCount: this.fvgRegistry.filter(z => z.isActive).length,
                atr: this.currentATR,
            };
            return signal;
        }

        this.lastHeartbeat = {
            trend, fvg: fvgLabel, decision: 'HOLD',
            activeFvgCount: this.fvgRegistry.filter(z => z.isActive).length,
            atr: this.currentATR,
        };
        return holdSignal;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FVG Detection — scans the last 3 completed candles for new gaps
    // ─────────────────────────────────────────────────────────────────────────

    private detectNewFvgs(vwap: number): void {
        const len = this.candles.length;
        if (len < 4) return;

        // FVG candles: c1 (edge), c2 (displacement), c3 (edge)
        // We look at [len-4, len-3, len-2] as the formation, len-1 is current
        const c1 = this.candles[len - 4];
        const c2 = this.candles[len - 3];
        const c3 = this.candles[len - 2];

        const minGap = this.currentATR * FVG_GAP_ATR_MULT;

        // --- Volume validation (median-based with outlier cap) ---
        const medianVol = this.getMedianVolume();
        const volCap = medianVol * VOLUME_OUTLIER_CAP;
        const c2VolCapped = Math.min(c2.volume, volCap);
        const isVolumeValid = c2VolCapped >= medianVol * VOLUME_SPIKE_MULT;

        // --- MSS validation (3-bar pivot swing detection) ---
        const recentSwingHigh = this.findRecentSwingHigh();
        const recentSwingLow = this.findRecentSwingLow();

        const timeStr = new Date(c3.timestamp).toLocaleTimeString('en-US', {
            timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit',
        });

        // ── Bullish FVG: c1.high < c3.low (price jumped up, leaving a void) ──
        if (c1.high < c3.low) {
            const gapSize = c3.low - c1.high;
            if (gapSize >= minGap) {
                // Check for MSS: displacement breaks the most recent swing high
                const mssValid = recentSwingHigh !== null && c2.close > recentSwingHigh;

                if (!isVolumeValid) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bullish FVG rejected (Volume insufficient — c2: ${c2.volume.toFixed(0)}, median: ${medianVol.toFixed(0)}).`);
                } else if (!mssValid) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bullish FVG rejected (MSS failed — no recent swing high break).`);
                } else {
                    // Valid FVG — add to persistent registry
                    const vwapConfluence = vwap > 0 && c3.low <= vwap * 1.002 && c1.high >= vwap * 0.998;
                    this.fvgRegistry.push({
                        direction:     'BULLISH',
                        top:           c3.low,
                        bottom:        c1.high,
                        formationTime: c3.timestamp,
                        formationIdx:  this.candleCount - 2,
                        isActive:      true,
                        vwapConfluence,
                    });
                    console.log(
                        `[SMC] 🟢 Bullish FVG REGISTERED | Zone: [${c1.high.toFixed(2)}, ${c3.low.toFixed(2)}] | ` +
                        `Gap: ${gapSize.toFixed(2)} pts (ATR min: ${minGap.toFixed(2)}) | VWAP confluence: ${vwapConfluence}`
                    );
                }
            }
        }

        // ── Bearish FVG: c1.low > c3.high (price dropped, leaving a void) ──
        if (c1.low > c3.high) {
            const gapSize = c1.low - c3.high;
            if (gapSize >= minGap) {
                const mssValid = recentSwingLow !== null && c2.close < recentSwingLow;

                if (!isVolumeValid) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bearish FVG rejected (Volume insufficient).`);
                } else if (!mssValid) {
                    this.dailyRejectedSetups.push(`${timeStr}: Bearish FVG rejected (MSS failed — no recent swing low break).`);
                } else {
                    const vwapConfluence = vwap > 0 && c3.high >= vwap * 0.998 && c1.low <= vwap * 1.002;
                    this.fvgRegistry.push({
                        direction:     'BEARISH',
                        top:           c1.low,
                        bottom:        c3.high,
                        formationTime: c3.timestamp,
                        formationIdx:  this.candleCount - 2,
                        isActive:      true,
                        vwapConfluence,
                    });
                    console.log(
                        `[SMC] 🔴 Bearish FVG REGISTERED | Zone: [${c3.high.toFixed(2)}, ${c1.low.toFixed(2)}] | ` +
                        `Gap: ${gapSize.toFixed(2)} pts | VWAP confluence: ${vwapConfluence}`
                    );
                }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FVG Registry Update — mitigate or invalidate stale zones
    // ─────────────────────────────────────────────────────────────────────────

    private updateFvgRegistry(candle: Candle): void {
        for (const fvg of this.fvgRegistry) {
            if (!fvg.isActive) continue;

            // Age-based invalidation
            const age = this.candleCount - fvg.formationIdx;
            if (age > MAX_FVG_AGE_CANDLES) {
                fvg.isActive = false;
                continue;
            }

            // Mitigation: price has fully traded through the zone
            if (fvg.direction === 'BULLISH') {
                // Invalidated if price closes decisively below the bottom of the gap
                if (candle.close < fvg.bottom - this.currentATR * 0.5) {
                    fvg.isActive = false;
                }
            } else {
                // Bearish FVG invalidated if price closes above the top
                if (candle.close > fvg.top + this.currentATR * 0.5) {
                    fvg.isActive = false;
                }
            }
        }

        // Prune inactive zones (keep array clean)
        this.fvgRegistry = this.fvgRegistry.filter(z => z.isActive);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Tap Entry Scan — check ALL active FVGs for re-entry
    // ─────────────────────────────────────────────────────────────────────────

    private scanForTapEntry(
        candle: Candle,
        vwap: number,
        trend: HeartbeatSnapshot['trend'],
    ): SmcSignal | null {

        // Sort by most recent first (prefer fresh FVGs)
        const activeFvgs = this.fvgRegistry
            .filter(z => z.isActive)
            .sort((a, b) => b.formationIdx - a.formationIdx);

        for (const fvg of activeFvgs) {

            if (fvg.direction === 'BULLISH') {
                // Tap: candle's low dips into the FVG zone, candle closes above the bottom
                const tapped = candle.low <= fvg.top && candle.close > fvg.bottom;
                if (!tapped) continue;

                // ── Confluence Scoring ────────────────────────────────────
                let confidence = 3; // Base: valid FVG tap
                if (trend === 'Bullish')      confidence += 2; // VWAP trend aligned
                if (fvg.vwapConfluence)        confidence += 2; // FVG at VWAP = premium
                if (vwap > 0 && candle.close > vwap) confidence += 1; // Price above VWAP

                // Mark as mitigated (no double-tapping)
                fvg.isActive = false;

                console.log(
                    `[SMC] 🎯 BULLISH FVG TAP | Zone: [${fvg.bottom.toFixed(2)}, ${fvg.top.toFixed(2)}] | ` +
                    `Age: ${this.candleCount - fvg.formationIdx} candles | Confidence: ${confidence}/8`
                );

                return {
                    action:     'BUY',
                    confidence,
                    fvgZone:    fvg,
                    reason:     `Bullish FVG tap [${fvg.bottom.toFixed(2)}-${fvg.top.toFixed(2)}] | conf=${confidence}`,
                };
            }

            if (fvg.direction === 'BEARISH') {
                // Tap: candle's high reaches into the FVG zone, candle closes below the top
                const tapped = candle.high >= fvg.bottom && candle.close < fvg.top;
                if (!tapped) continue;

                let confidence = 3;
                if (trend === 'Bearish')      confidence += 2;
                if (fvg.vwapConfluence)        confidence += 2;
                if (vwap > 0 && candle.close < vwap) confidence += 1;

                fvg.isActive = false;

                console.log(
                    `[SMC] 🎯 BEARISH FVG TAP | Zone: [${fvg.bottom.toFixed(2)}, ${fvg.top.toFixed(2)}] | ` +
                    `Age: ${this.candleCount - fvg.formationIdx} candles | Confidence: ${confidence}/8`
                );

                return {
                    action:     'SELL',
                    confidence,
                    fvgZone:    fvg,
                    reason:     `Bearish FVG tap [${fvg.bottom.toFixed(2)}-${fvg.top.toFixed(2)}] | conf=${confidence}`,
                };
            }
        }

        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers — Swing Detection, Median Volume
    // ─────────────────────────────────────────────────────────────────────────

    /** Finds the most recent 3-bar pivot swing high (a high with lower highs on both sides). */
    private findRecentSwingHigh(): number | null {
        const len = this.candles.length;
        // Start from len-5 to avoid the FVG candles themselves
        for (let i = len - 5; i >= SWING_PIVOT_BARS; i--) {
            const c = this.candles[i];
            let isPivot = true;
            for (let j = 1; j <= SWING_PIVOT_BARS; j++) {
                if (i - j < 0 || i + j >= len) { isPivot = false; break; }
                if (this.candles[i - j].high >= c.high || this.candles[i + j].high >= c.high) {
                    isPivot = false;
                    break;
                }
            }
            if (isPivot) return c.high;
        }
        return null;
    }

    /** Finds the most recent 3-bar pivot swing low. */
    private findRecentSwingLow(): number | null {
        const len = this.candles.length;
        for (let i = len - 5; i >= SWING_PIVOT_BARS; i--) {
            const c = this.candles[i];
            let isPivot = true;
            for (let j = 1; j <= SWING_PIVOT_BARS; j++) {
                if (i - j < 0 || i + j >= len) { isPivot = false; break; }
                if (this.candles[i - j].low <= c.low || this.candles[i + j].low <= c.low) {
                    isPivot = false;
                    break;
                }
            }
            if (isPivot) return c.low;
        }
        return null;
    }

    /** Returns the median volume of the last 15 candles (or fewer). */
    private getMedianVolume(): number {
        const len = this.candles.length;
        const lookbackSize = Math.min(15, len);
        if (lookbackSize === 0) return 0;

        const vols = this.candles.slice(-lookbackSize).map(c => c.volume).sort((a, b) => a - b);
        const mid = Math.floor(vols.length / 2);
        return vols.length % 2 === 0 ? (vols[mid - 1] + vols[mid]) / 2 : vols[mid];
    }

    /** Returns the current 14-period ATR. Used by MomWorker for dynamic SL. */
    public getATR(): number {
        return this.currentATR;
    }

    /** Returns the count of currently active (unmitigated) FVGs. */
    public getActiveFvgCount(): number {
        return this.fvgRegistry.filter(z => z.isActive).length;
    }

    /**
     * Clears the daily rejected setups log. Called by the EoDR generator after archiving.
     */
    public clearDailyRejections(): void {
        this.dailyRejectedSetups = [];
    }
}
