/**
 * etLogger.ts — Global ET Timestamp Prefixer
 * ─────────────────────────────────────────────────────────────────────────────
 * Import this at the TOP of every worker thread and index.ts.
 * Overrides console.log/warn/error to prefix with [HH:MM:SS ET].
 * All timestamps are Eastern Time for chart cross-referencing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

function etStamp(): string {
    return new Date().toLocaleTimeString('en-US', {
        timeZone: 'America/New_York',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    });
}

const _origLog  = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const _origErr  = console.error.bind(console);

console.log   = (...args: unknown[]) => _origLog(`[${etStamp()}]`, ...args);
console.warn  = (...args: unknown[]) => _origWarn(`[${etStamp()}]`, ...args);
console.error = (...args: unknown[]) => _origErr(`[${etStamp()}]`, ...args);
