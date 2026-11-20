// Order APIs — behaviour verified as CORRECT during the audit (ORD-01/02/04/05/07/08/09/14).
// Orders are created in the isolated test DB via the COD endpoint only; Razorpay is never configured or called.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Order APIs', { skip: ctx.skipReason }, () => {
  let fx;
  let order;
  const setStatus = (id, status) => ctx.request('PATCH', `/orders/${id}/status`, { token: fx.tokens.admin, body: { status } });
  before(async () => { fx = await ctx.seed(); });

  test('ORD-01/02 COD order: totals computed server-side, free shipping ≥ ₹999, stock decremented', async () => {
    const res = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.trim._id), quantity: 1 }]);
    expectStatus(assert, res, 201);
    order = res.body.order;
    assert.equal(order.subtotal, 1200);
    assert.equal(order.shipping, 0);
    assert.equal(order.total, 1200);
    assert.equal(order.status, 'pending');
    assert.equal(order.paymentMethod, 'cod');
    assert.equal(order.paymentStatus, 'pending');
    assert.equal((await ctx.models.Product.findById(fx.trim._id)).stock, 2);
  });

  test('ORD-01b client-supplied prices are ignored; shipping ₹99 below ₹999', async () => {
    const res = await ctx.request('POST', '/orders', {
      token: fx.tokens.customer,
      body: {
        items: [{ productId: String(fx.lace._id), quantity: 1, price: 1 }],
        shippingAddress: { line1: 'x', pincode: '400001' },
        subtotal: 1, total: 1,
      },
    });
    expectStatus(assert, res, 201);
    assert.equal(res.body.order.items[0].price, 500);
    assert.equal(res.body.order.subtotal, 500);
    assert.equal(res.body.order.shipping, 99);
    assert.equal(res.body.order.total, 599);
  });

  test('ORD-01c rejects empty cart, missing address, insufficient stock and inactive products', async () => {
    expectStatus(assert, await ctx.placeOrder(fx.tokens.customer, []), 400);
    expectStatus(assert, await ctx.request('POST', '/orders', {
      token: fx.tokens.customer, body: { items: [{ productId: String(fx.lace._id), quantity: 1 }], shippingAddress: {} },
    }), 400);
    expectStatus(assert, await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 999 }]), 400);
    const inactive = await ctx.models.Product.create({ title: 'Inactive', slug: 'inactive', category: fx.laces._id, price: 10, stock: 5, isActive: false });
    expectStatus(assert, await ctx.placeOrder(fx.tokens.customer, [{ productId: String(inactive._id), quantity: 1 }]), 400);
  });

  test('ORD-01d placing an order requires authentication', async () => {
    expectStatus(assert, await ctx.placeOrder(undefined, [{ productId: String(fx.lace._id), quantity: 1 }]), 401);
  });

  test('ORD-04 admin lists all orders, newest first', async () => {
    const res = await ctx.request('GET', '/orders', { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    assert.equal(res.body.orders.length, await ctx.models.Order.countDocuments());
    const dates = res.body.orders.map((o) => Date.parse(o.createdAt));
    assert.ok(dates.every((d, i) => i === 0 || dates[i - 1] >= d));
  });

  test('ORD-05 admin status filter', async () => {
    const res = await ctx.request('GET', '/orders?status=pending', { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    assert.ok(res.body.orders.length >= 1);
    assert.ok(res.body.orders.every((o) => o.status === 'pending'));
  });

  test('ORD-07 valid forward transition pending → processing persists', async () => {
    const res = await setStatus(order._id, 'processing');
    expectStatus(assert, res, 200);
    assert.equal(res.body.order.status, 'processing');
    assert.equal((await ctx.models.Order.findById(order._id)).status, 'processing');
  });

  test('ORD-08 repeating the same status is idempotent', async () => {
    const res = await setStatus(order._id, 'processing');
    expectStatus(assert, res, 200);
    assert.equal(res.body.order.status, 'processing');
  });

  test('ORD-09 unknown status value → 400 and unchanged', async () => {
    expectStatus(assert, await setStatus(order._id, 'teleported'), 400);
    expectStatus(assert, await setStatus(order._id, undefined), 400);
    assert.equal((await ctx.models.Order.findById(order._id)).status, 'processing');
  });

  test('ORD-14 status update for a non-existent order → 404', async () => {
    expectStatus(assert, await setStatus(new ctx.mongoose.Types.ObjectId(), 'shipped'), 404);
  });

  test('ORD-20 customer sees only their own orders and can cancel a pending one', async () => {
    const mine = await ctx.request('GET', '/orders/my', { token: fx.tokens.customer });
    expectStatus(assert, mine, 200);
    assert.ok(mine.body.orders.every((o) => o.user === String(fx.customer._id)));
    const fresh = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 1 }]);
    const cancel = await ctx.request('PATCH', `/orders/my/${fresh.body.order._id}/cancel`, { token: fx.tokens.customer });
    expectStatus(assert, cancel, 200);
    assert.equal(cancel.body.order.status, 'cancelled');
  });

  test('ORD-21 customer cannot cancel an order that has shipped', async () => {
    const fresh = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 1 }]);
    await setStatus(fresh.body.order._id, 'shipped');
    const res = await ctx.request('PATCH', `/orders/my/${fresh.body.order._id}/cancel`, { token: fx.tokens.customer });
    expectStatus(assert, res, 400);
  });

  test('ORD-22 public tracking requires matching order number AND email', async () => {
    expectStatus(assert, await ctx.request('GET', `/orders/track?orderNumber=${order.orderNumber}&email=customer@parisutra.test`), 200);
    expectStatus(assert, await ctx.request('GET', `/orders/track?orderNumber=${order.orderNumber}&email=someone@else.test`), 404);
    expectStatus(assert, await ctx.request('GET', '/orders/track'), 400);
  });
});
