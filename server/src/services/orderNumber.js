import { Counter } from '../models/Counter.js';
import { Order } from '../models/Order.js';

/**
 * Atomic order numbers (Milestone 5B).
 *
 * Format (unchanged): "AL" + sequence, e.g. AL10001. The previous generator produced
 * AL(10000 + count + 1), so sequences start above LEGACY_BASE.
 *
 * Flow:
 *   1. Once per process, syncCounterFloor() raises the counter to at least the highest existing
 *      AL<digits> order number (atomic $max with upsert: never lowers it, safe if many processes
 *      start at once; an upsert duplicate-key race is retried).
 *   2. allocateOrderNumber() takes the next value with an atomic $inc, so concurrent requests can
 *      never receive the same number. A number is never reused; failed orders leave gaps.
 *
 * Sequential numbers stop collisions; they are NOT secret or unguessable.
 */

export const ORDER_COUNTER_ID = 'orderNumber';
export const ORDER_NUMBER_PREFIX = 'AL';
export const LEGACY_BASE = 10000;
const MAX_DIGITS = 15; // stays well inside Number.MAX_SAFE_INTEGER
const STANDARD = new RegExp(`^${ORDER_NUMBER_PREFIX}([0-9]{1,${MAX_DIGITS}})$`);

export const formatOrderNumber = (seq) => `${ORDER_NUMBER_PREFIX}${seq}`;

/** Sequence of a standard order number ("AL10042" → 10042), or null for anything else. */
export function parseOrderNumber(value) {
  const match = typeof value === 'string' ? STANDARD.exec(value) : null;
  return match ? Number(match[1]) : null;
}

/** Highest sequence among existing standard order numbers (0 when there are none). */
export async function historicalMaxSequence() {
  const [row] = await Order.aggregate([
    { $match: { orderNumber: { $regex: STANDARD.source } } },
    { $group: { _id: null, max: { $max: { $toLong: { $substrCP: ['$orderNumber', ORDER_NUMBER_PREFIX.length, MAX_DIGITS] } } } } },
  ]);
  return row ? Number(row.max) : 0;
}

/**
 * Raises the counter to max(LEGACY_BASE, historical maximum) and returns its value.
 * Creates the counter if missing. Never lowers an existing (higher) counter.
 */
export async function syncCounterFloor() {
  const floor = Math.max(LEGACY_BASE, await historicalMaxSequence());
  for (let attempt = 1; ; attempt += 1) {
    try {
      const counter = await Counter.findOneAndUpdate(
        { _id: ORDER_COUNTER_ID },
        { $max: { seq: floor } },
        { upsert: true, new: true }
      );
      return counter.seq;
    } catch (err) {
      // Two first-time upserts can race on _id; the loser retries and simply applies $max.
      if (err?.code === 11000 && attempt < 5) continue;
      throw err;
    }
  }
}

let ready = null;

/** Runs syncCounterFloor() once per process (retried on the next call if it failed). */
export function ensureOrderCounter() {
  if (!ready) ready = syncCounterFloor().catch((err) => { ready = null; throw err; });
  return ready;
}

/** Forces a fresh floor sync, e.g. after a duplicate order number was detected. */
export function resyncOrderCounter() {
  ready = null;
  return ensureOrderCounter();
}

/** Atomically allocates the next order number. */
export async function allocateOrderNumber() {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await ensureOrderCounter();
    const counter = await Counter.findOneAndUpdate(
      { _id: ORDER_COUNTER_ID },
      { $inc: { seq: 1 } },
      { new: true }
    );
    if (counter) return formatOrderNumber(counter.seq);
    // The counter document disappeared after the sync (e.g. dropped by hand): rebuild it from history.
    ready = null;
  }
  throw new Error('Could not allocate an order number');
}

export const isDuplicateOrderNumberError = (err) =>
  err?.code === 11000 && Boolean(err.keyPattern?.orderNumber || /orderNumber/.test(err.message || ''));

/**
 * Read-only data check: duplicate order numbers, numbers outside the standard format, and the
 * highest standard sequence. Never modifies anything.
 */
export async function auditOrderNumbers() {
  const [duplicates, nonStandard, nonStandardCount, maxSequence, counter] = await Promise.all([
    Order.aggregate([
      { $group: { _id: '$orderNumber', count: { $sum: 1 }, ids: { $push: '$_id' } } },
      { $match: { count: { $gt: 1 } } },
      { $project: { _id: 0, orderNumber: '$_id', count: 1, ids: 1 } },
    ]),
    Order.find({ orderNumber: { $not: STANDARD } }).select('orderNumber').limit(20).lean(),
    Order.countDocuments({ orderNumber: { $not: STANDARD } }),
    historicalMaxSequence(),
    Counter.findById(ORDER_COUNTER_ID).lean(),
  ]);
  return {
    duplicates,
    nonStandardCount,
    nonStandardSamples: nonStandard.map((o) => o.orderNumber ?? null),
    maxSequence,
    counter: counter?.seq ?? null,
  };
}
