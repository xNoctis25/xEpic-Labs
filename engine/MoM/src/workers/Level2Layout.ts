/**
 * Level2Layout — SharedArrayBuffer Memory Layout Constants
 *
 * IMPORTANT: These constants define the binary contract between the
 * Level2DataStore (main thread reader) and Level2Worker (worker writer).
 * Both files import from here to stay in sync. Do NOT modify these
 * values without updating both sides.
 *
 * Memory Layout:
 *   Bytes [0..3]    Int32    Sequence counter (SeqLock — odd = writing, even = safe)
 *   Bytes [4..7]    ---      Padding (8-byte alignment for Float64)
 *   Bytes [8..]     Float64  DOM data array:
 *     [0]           timestamp (epoch ms)
 *     [1]           bid_count (0-10)
 *     [2]           ask_count (0-10)
 *     [3..22]       bids: 10 levels × 2 fields (price, size)
 *     [23..42]      asks: 10 levels × 2 fields (price, size)
 *
 * Total: 8 header + (43 × 8) data = 352 bytes
 */

export const HEADER_BYTES = 8;         // Int32 SeqLock + padding
export const DOM_DEPTH = 10;           // 10 price levels per side
export const FIELDS_PER_LEVEL = 2;     // price, size
export const META_FIELDS = 3;          // timestamp, bid_count, ask_count
export const DATA_SLOTS = META_FIELDS + (DOM_DEPTH * FIELDS_PER_LEVEL * 2); // 43
export const SAB_BYTE_LENGTH = HEADER_BYTES + (DATA_SLOTS * 8);             // 352

// Float64Array index offsets (relative to the Float64 view, NOT byte offsets)
export const IDX_TIMESTAMP  = 0;
export const IDX_BID_COUNT  = 1;
export const IDX_ASK_COUNT  = 2;
export const IDX_BIDS_START = 3;                                    // bids[0].price
export const IDX_ASKS_START = 3 + (DOM_DEPTH * FIELDS_PER_LEVEL);  // 23 — asks[0].price
