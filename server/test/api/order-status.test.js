// Order state machine and exactly-once stock restoration (Milestone 5D).
// The harness runs MongoDB as a single-node replica set, so cancellation uses real transactions here.
// Deterministic concurrency: services/orderStatus.js cancelOrder() is also called in-process with
// test-only hooks (barriers, failures at chosen points). Isolated MongoDB only.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

const status = ctx.skipReason ? null : await import('../../src/services/orderStatus.js');
const orderSvc = ctx.skipReason ? null : await import('../../src/services/orderService.js');
const STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
const ADDRESS = { fullName: 'Test', phone: '9999999999', line1: 'Test line', city: 'Test', state: 'Test', pincode: '400001' };

function barrier(n) {
  let arrived = 0;
  let release;
  const all = new Promise((r) => { release = r; });
  return async () => {
    arrived += 1;
    if (arrived >= n) release();
    await all;
  };
}

describe('Order status transitions and cancellation', { skip: ctx.skipReason }, () => {
  let fx;
  let other;
  const P = () => ctx.models.Product;
  const O = () => ctx.models.Order;
  const stockOf = async (id) => (await P().findById(id)).stock;
  const setStock = (id, stock) => P().updateOne({ _id: id }, { stock, isActive: true, trackStock: true });
  const admin = (id, s) => ctx.request('PATCH', `/orders/${id}/status`, { token: fx.tokens.admin, body: { status: s } });
  const customerCancel = (id, token = fx.tokens.customer) => ctx.request('PATCH', `/orders/my/${id}/cancel`, { token });
  async function placeOrder(lines) {
    const res = await ctx.placeOrder(fx.tokens.customer, lines);
    expectStatus(assert, res, 201, 'fixture order');
    return res.body.order;
  }
  const laceOrder = (quantity = 1) => placeOrder([{ productId: String(fx.lace._id), quantity }]);

  before(async () => {
    fx = await ctx.seed();
    await setStock(fx.lace._id, 1000);
    await setStock(fx.trim._id, 1000);
    other = await ctx.models.User.create({ name: 'Other', email: 'other@parisutra.test', password: 'OtherPass123', role: 'customer' });
    other.token = await ctx.login('other@parisutra.test', 'OtherPass123');
  });

  test('OS-01 transition matrix: every allowed move succeeds, every other move is rejected, same status is a no-op', async () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        const order = await laceOrder();
        await O().updateOne({ _id: order._id }, { status: from });
        const res = await admin(order._id, to);
        const stored = (await O().findById(order._id)).status;
        if (from === to) {
          expectStatus(assert, res, 200, `${from} → ${to} (same)`);
          assert.equal(res.body.changed, false, `${from} → ${to}`);
          assert.equal(stored, from);
        } else if (status.canTransition(from, to)) {
          expectStatus(assert, res, 200, `${from} → ${to}`);
          assert.equal(res.body.changed, true);
          assert.equal(stored, to);
        } else {
          expectStatus(assert, res, 400, `${from} → ${to}`);
          assert.match(res.body.message, new RegExp(`${from} order`));
          assert.equal(stored, from, `${from} → ${to} must not persist`);
        }
      }
    }
  });

  test('OS-02 invalid input, missing orders and authorization', async () => {
    const order = await laceOrder();
    for (const bad of ['teleported', '', null, 1, ['cancelled'], { $ne: 'x' }]) {
      expectStatus(assert, await admin(order._id, bad), 400, JSON.stringify(bad));
    }
    expectStatus(assert, await admin(String(new ctx.mongoose.Types.ObjectId()), 'processing'), 404);
    expectStatus(assert, await admin(String(new ctx.mongoose.Types.ObjectId()), 'cancelled'), 404);
    expectStatus(assert, await admin('not-an-id', 'cancelled'), 400);
    expectStatus(assert, await ctx.request('PATCH', `/orders/${order._id}/status`, { token: fx.tokens.customer, body: { status: 'cancelled' } }), 403);
    expectStatus(assert, await ctx.request('PATCH', `/orders/${order._id}/status`, { body: { status: 'cancelled' } }), 401);
    expectStatus(assert, await ctx.request('PATCH', `/orders/my/${order._id}/cancel`), 401);
    expectStatus(assert, await customerCancel('not-an-id'), 400);
    assert.equal((await O().findById(order._id)).status, 'pending');
  });

  test('OS-03 admin cancellation restores the exact quantities of every product, once', async () => {
    await setStock(fx.lace._id, 10);
    await setStock(fx.trim._id, 5);
    const order = await placeOrder([{ productId: String(fx.lace._id), quantity: 3 }, { productId: String(fx.trim._id), quantity: 2 }]);
    assert.deepEqual([await stockOf(fx.lace._id), await stockOf(fx.trim._id)], [7, 3]);
    const res = await admin(order._id, 'cancelled');
    expectStatus(assert, res, 200);
    assert.equal(res.body.stockRestoration, 'restored');
    assert.deepEqual([await stockOf(fx.lace._id), await stockOf(fx.trim._id)], [10, 5]);
    const stored = await O().findById(order._id).lean();
    assert.equal(stored.status, 'cancelled');
    assert.equal(stored.cancelledBy, 'admin');
    assert.ok(stored.stockReservation.restoredAt);
    assert.deepEqual(stored.items.map((i) => i.quantity), [3, 2], 'item snapshots preserved');

    for (let i = 0; i < 3; i += 1) {
      const again = await admin(order._id, 'cancelled');
      expectStatus(assert, again, 200);
      assert.equal(again.body.changed, false);
      assert.equal(again.body.stockRestoration, 'already-restored');
    }
    expectStatus(assert, await customerCancel(order._id), 200);
    assert.deepEqual([await stockOf(fx.lace._id), await stockOf(fx.trim._id)], [10, 5], 'repeats change nothing');
  });

  test('OS-04 customers cancel only their own pending/processing orders; stock restored once', async () => {
    await setStock(fx.lace._id, 10);
    const order = await laceOrder(4);
    expectStatus(assert, await customerCancel(order._id, other.token), 404, 'another customer');
    assert.equal(await stockOf(fx.lace._id), 6, 'no restoration triggered by another customer');
    assert.equal((await O().findById(order._id)).status, 'pending');

    const res = await customerCancel(order._id);
    expectStatus(assert, res, 200);
    assert.equal(res.body.stockRestoration, 'restored');
    assert.equal(res.body.order.cancelledBy, 'customer');
    expectStatus(assert, await customerCancel(order._id), 200);
    expectStatus(assert, await admin(order._id, 'cancelled'), 200);
    assert.equal(await stockOf(fx.lace._id), 10);

    const processing = await laceOrder(2);
    await admin(processing._id, 'processing');
    expectStatus(assert, await customerCancel(processing._id), 200);
    assert.equal(await stockOf(fx.lace._id), 10);

    for (const final of ['shipped', 'delivered']) {
      const o = await laceOrder(1);
      await O().updateOne({ _id: o._id }, { status: final });
      const r = await customerCancel(o._id);
      expectStatus(assert, r, 400, final);
      assert.equal((await O().findById(o._id)).status, final);
      expectStatus(assert, await admin(o._id, 'cancelled'), 400, `admin cancel ${final}`);
    }
    assert.equal(await stockOf(fx.lace._id), 8, 'shipped/delivered orders keep their stock deducted');
  });

  test('OS-05 deterministic race: customer and admin cancel together after both read "pending"', async () => {
    await setStock(fx.lace._id, 10);
    const order = await laceOrder(3);
    const bothRead = barrier(2);
    const [a, b] = await Promise.all([
      status.cancelOrder({ orderId: order._id, actor: 'customer', ownerId: fx.customer._id, hooks: { afterRead: bothRead } }),
      status.cancelOrder({ orderId: order._id, actor: 'admin', hooks: { afterRead: bothRead } }),
    ]);
    assert.deepEqual([a.changed, b.changed].sort(), [false, true], 'exactly one cancellation took effect');
    assert.equal(await stockOf(fx.lace._id), 10, 'restored exactly once');
  });

  test('OS-06 deterministic race: 5 admin cancellations after all read "pending"; plus 10 simultaneous HTTP retries', async () => {
    await setStock(fx.lace._id, 10);
    const order = await laceOrder(2);
    const allRead = barrier(5);
    const results = await Promise.all(Array.from({ length: 5 }, () => status.cancelOrder({ orderId: order._id, actor: 'admin', hooks: { afterRead: allRead } })));
    assert.equal(results.filter((r) => r.changed).length, 1);
    assert.equal(await stockOf(fx.lace._id), 10);

    const second = await laceOrder(5);
    const http = await Promise.all([
      ...Array.from({ length: 5 }, () => admin(second._id, 'cancelled')),
      ...Array.from({ length: 5 }, () => customerCancel(second._id)),
    ]);
    assert.deepEqual(http.map((r) => r.status), Array(10).fill(200));
    assert.equal(http.filter((r) => r.body.changed).length, 1);
    assert.equal(await stockOf(fx.lace._id), 10);
  });

  test('OS-07 competing ship vs cancel: one wins, and stock matches the winner', async () => {
    for (let round = 0; round < 5; round += 1) {
      await setStock(fx.lace._id, 10);
      const order = await laceOrder(4);
      await admin(order._id, 'processing');
      const results = await Promise.all([admin(order._id, 'shipped'), admin(order._id, 'cancelled'), customerCancel(order._id), admin(order._id, 'shipped')]);
      const final = (await O().findById(order._id)).status;
      assert.ok(['shipped', 'cancelled'].includes(final));
      assert.equal(await stockOf(fx.lace._id), final === 'cancelled' ? 10 : 6, `round ${round}: ${final}, ${results.map((r) => r.status)}`);
    }
  });

  test('OS-08 a failure during cancellation rolls everything back; a retry then restores once', async () => {
    await setStock(fx.lace._id, 10);
    await setStock(fx.trim._id, 5);
    const order = await placeOrder([{ productId: String(fx.lace._id), quantity: 3 }, { productId: String(fx.trim._id), quantity: 2 }]);
    await assert.rejects(status.cancelOrder({
      orderId: order._id, actor: 'admin',
      hooks: { afterRestoreLine: (line) => { if (String(line.product) === String(fx.lace._id)) throw new Error('crash after first product'); } },
    }), /crash after first product/);
    let stored = await O().findById(order._id).lean();
    assert.equal(stored.status, 'pending', 'order not cancelled');
    assert.equal(stored.stockReservation.restoredAt, undefined);
    assert.deepEqual([await stockOf(fx.lace._id), await stockOf(fx.trim._id)], [7, 3], 'no partial restoration committed');

    await assert.rejects(status.cancelOrder({ orderId: order._id, actor: 'admin', hooks: { beforeCommit: () => { throw new Error('crash before commit'); } } }), /before commit/);
    assert.deepEqual([await stockOf(fx.lace._id), await stockOf(fx.trim._id)], [7, 3]);

    const res = await admin(order._id, 'cancelled');
    expectStatus(assert, res, 200);
    assert.deepEqual([await stockOf(fx.lace._id), await stockOf(fx.trim._id)], [10, 5]);
    stored = await O().findById(order._id).lean();
    assert.ok(stored.stockReservation.restoredAt);
  });

  test('OS-09 restoration state survives an application restart', async () => {
    await setStock(fx.lace._id, 10);
    const order = await laceOrder(3);
    expectStatus(assert, await admin(order._id, 'cancelled'), 200);
    assert.equal(await stockOf(fx.lace._id), 10);
    await ctx.restartApi();
    const again = await admin(order._id, 'cancelled');
    expectStatus(assert, again, 200);
    assert.equal(again.body.changed, false);
    expectStatus(assert, await customerCancel(order._id), 200);
    assert.equal(await stockOf(fx.lace._id), 10);
  });

  test('OS-10 orders without a recorded deduction are cancelled without touching stock', async () => {
    // Older order (created before reservations were recorded).
    await setStock(fx.lace._id, 10);
    const legacy = await O().create({
      orderNumber: 'AL99001', user: fx.customer._id, customerEmail: 'customer@parisutra.test',
      items: [{ product: fx.lace._id, title: 'Test Gold Lace', price: 500, quantity: 4 }], subtotal: 2000, shipping: 0, total: 2000,
    });
    const r1 = await admin(legacy._id, 'cancelled');
    expectStatus(assert, r1, 200);
    assert.equal(r1.body.stockRestoration, 'not-recorded');
    assert.equal(await stockOf(fx.lace._id), 10, 'no inventory inflation');

    // Razorpay-path order (createOrder deducts but does not record): left for Phase 5H.
    const paid = await orderSvc.createOrder({
      userId: fx.customer._id, items: [{ productId: String(fx.lace._id), quantity: 2 }], shippingAddress: ADDRESS,
      paymentMethod: 'razorpay', paymentStatus: 'paid', customerEmail: 'customer@parisutra.test',
    });
    assert.equal(await stockOf(fx.lace._id), 8);
    const r2 = await admin(paid._id, 'cancelled');
    expectStatus(assert, r2, 200);
    assert.equal(r2.body.stockRestoration, 'not-recorded');
    assert.equal(r2.body.order.paymentStatus, 'paid', 'payment fields untouched');
    assert.equal(await stockOf(fx.lace._id), 8);

    // Untracked product: nothing was reserved, so nothing is restored.
    await P().updateOne({ _id: fx.trim._id }, { stock: 0, trackStock: false });
    const untracked = await placeOrder([{ productId: String(fx.trim._id), quantity: 3 }]);
    expectStatus(assert, await admin(untracked._id, 'cancelled'), 200);
    assert.equal(await stockOf(fx.trim._id), 0);
    await setStock(fx.trim._id, 1000);
  });

  test('OS-11 a product deleted after ordering does not block cancellation of the rest', async () => {
    await setStock(fx.lace._id, 10);
    const temp = await P().create({ title: 'Temp Product', slug: 'temp-product-5d', category: fx.laces._id, price: 10, stock: 5 });
    const order = await placeOrder([{ productId: String(fx.lace._id), quantity: 2 }, { productId: String(temp._id), quantity: 1 }]);
    await P().deleteOne({ _id: temp._id });
    const res = await admin(order._id, 'cancelled');
    expectStatus(assert, res, 200);
    assert.equal(await stockOf(fx.lace._id), 10);
    const stored = await O().findById(order._id).lean();
    assert.deepEqual(stored.stockReservation.missingProducts.map(String), [String(temp._id)]);
  });

  test('OS-12 cancelled orders stay readable and trackable; tracking does not expose reservation data', async () => {
    const order = await laceOrder(1);
    await customerCancel(order._id);
    const mine = await ctx.request('GET', `/orders/my/${order._id}`, { token: fx.tokens.customer });
    expectStatus(assert, mine, 200);
    assert.equal(mine.body.order.status, 'cancelled');
    const track = await ctx.request('GET', `/orders/track?orderNumber=${order.orderNumber}&email=customer@parisutra.test`);
    expectStatus(assert, track, 200);
    assert.equal(track.body.order.status, 'cancelled');
    assert.ok(!('stockReservation' in track.body.order) && !('cancelledBy' in track.body.order));
  });

  test('OS-13 COD orders record exactly what was reserved', async () => {
    await setStock(fx.lace._id, 50);
    const order = await placeOrder([{ productId: String(fx.lace._id), quantity: 2 }, { productId: String(fx.lace._id), quantity: 1 }]);
    const stored = await O().findById(order._id).lean();
    assert.ok(stored.stockReservation.reservedAt);
    assert.deepEqual(stored.stockReservation.lines.map((l) => [String(l.product), l.quantity]), [[String(fx.lace._id), 3]]);
  });
});
