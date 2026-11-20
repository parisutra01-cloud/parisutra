import mongoose from 'mongoose';
import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';

/**
 * Order state machine and cancellation (Milestone 5D). Used by both the admin status endpoint and
 * the customer cancel endpoint.
 *
 *   pending ──► processing ──► shipped ──► delivered
 *      │  └──────────────────────▲
 *      └──► cancelled ◄── processing
 *
 * pending → shipped is allowed (orders can be dispatched without a separate processing step; the
 * existing stable test ORD-21 relies on it). delivered and cancelled are terminal. Setting the
 * current status again is a no-op (200, no side effects).
 */
export const ORDER_TRANSITIONS = Object.freeze({
  pending: ['processing', 'shipped', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
});

export const canTransition = (from, to) => Boolean(ORDER_TRANSITIONS[from]?.includes(to));

export class OrderStatusError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const notFound = () => new OrderStatusError(404, 'Order not found');
const invalidTransition = (from, to) => new OrderStatusError(
  400,
  ORDER_TRANSITIONS[from]?.length
    ? `A ${from} order cannot be changed to ${to}. Allowed: ${ORDER_TRANSITIONS[from].join(', ')}.`
    : `A ${from} order is final and cannot be changed to ${to}.`
);

/** Transactions need a replica set (Atlas always is); a standalone mongod reports these errors. */
export const isTransactionUnsupported = (err) =>
  err?.code === 20 || /Transaction numbers are only allowed|replica set member or mongos/i.test(err?.message || '');

function assertId(orderId) {
  if (!mongoose.isValidObjectId(orderId)) throw new OrderStatusError(400, 'Invalid order id');
}

/**
 * Non-cancel transitions. A single conditional update ({ status: <current> }) makes concurrent
 * changes safe: if the status moved in between, the rule is re-evaluated against the new status.
 */
async function moveStatus(orderId, to) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const order = await Order.findById(orderId);
    if (!order) throw notFound();
    if (order.status === to) return { order, changed: false };
    if (!canTransition(order.status, to)) throw invalidTransition(order.status, to);
    const updated = await Order.findOneAndUpdate(
      { _id: order._id, status: order.status },
      { $set: { status: to } },
      { new: true }
    );
    if (updated) return { order: updated, changed: true };
  }
  throw new OrderStatusError(409, 'The order was changed at the same time. Please reload and try again.');
}

/**
 * Cancels an order and restores its recorded stock reservation exactly once.
 *
 * Everything happens in one MongoDB transaction: the conditional status change, every stock
 * increment and stockReservation.restoredAt. Competing cancellations of the same order conflict on
 * the order document; the driver retries the loser, which then sees the order already cancelled
 * and does nothing. If anything fails, nothing is committed (order not cancelled, no stock added).
 *
 * `ownerId` restricts the lookup to that customer's orders. `hooks` exist only for tests.
 */
export async function cancelOrder({ orderId, actor, ownerId, hooks = {} }) {
  assertId(orderId);
  const session = await mongoose.startSession();
  let outcome;
  try {
    await session.withTransaction(async () => {
      outcome = null;
      const filter = { _id: orderId, ...(ownerId ? { user: ownerId } : {}) };
      const order = await Order.findOne(filter).session(session);
      if (!order) throw notFound();
      if (order.status === 'cancelled') {
        outcome = { changed: false, stockRestoration: order.stockReservation?.restoredAt ? 'already-restored' : 'not-recorded' };
        return;
      }
      if (!canTransition(order.status, 'cancelled')) throw invalidTransition(order.status, 'cancelled');
      await hooks.afterRead?.(order);

      const now = new Date();
      const set = { status: 'cancelled', cancelledAt: now, cancelledBy: actor };
      const reservation = order.stockReservation;
      let stockRestoration = 'not-recorded';
      if (reservation?.reservedAt && !reservation.restoredAt) {
        const missing = [];
        for (const line of reservation.lines || []) {
          const res = await Product.updateOne({ _id: line.product }, { $inc: { stock: line.quantity } }, { session });
          if (res.matchedCount === 0) missing.push(line.product);
          await hooks.afterRestoreLine?.(line);
        }
        set['stockReservation.restoredAt'] = now;
        if (missing.length) set['stockReservation.missingProducts'] = missing;
        stockRestoration = 'restored';
      } else if (reservation?.restoredAt) {
        stockRestoration = 'already-restored';
      }

      const res = await Order.updateOne({ _id: order._id, status: order.status }, { $set: set }, { session });
      if (res.modifiedCount !== 1) {
        throw new OrderStatusError(409, 'The order was changed at the same time. Please reload and try again.');
      }
      await hooks.beforeCommit?.();
      outcome = { changed: true, stockRestoration };
    });
  } catch (err) {
    if (isTransactionUnsupported(err)) {
      throw new OrderStatusError(503, 'Order cancellation is unavailable: the database does not support transactions (a MongoDB replica set is required).');
    }
    throw err;
  } finally {
    await session.endSession();
  }
  const order = await Order.findById(orderId);
  return { order, ...outcome };
}

/** Admin: any permitted transition; cancellation goes through cancelOrder. */
export async function changeOrderStatus({ orderId, to, actor = 'admin', hooks }) {
  assertId(orderId);
  if (to === 'cancelled') return cancelOrder({ orderId, actor, hooks });
  return moveStatus(orderId, to);
}
