// REGRESSION — order lifecycle defects (ADM-006, ADM-007, ADM-011).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Order lifecycle regressions', { skip: ctx.skipReason }, () => {
  let fx;
  const setStatus = (id, status) => ctx.request('PATCH', `/orders/${id}/status`, { token: fx.tokens.admin, body: { status } });
  const newOrder = async (qty = 1) => {
    const res = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: qty }]);
    expectStatus(assert, res, 201, 'fixture order');
    return res.body.order;
  };
  before(async () => {
    fx = await ctx.seed();
    await ctx.models.Product.updateOne({ _id: fx.lace._id }, { stock: 500 });
  });

  test('ORD-11 (ADM-006) cancelled → delivered is rejected and the order stays cancelled', async () => {
    const o = await newOrder();
    expectStatus(assert, await setStatus(o._id, 'cancelled'), 200, 'precondition cancel');
    expectStatus(assert, await setStatus(o._id, 'delivered'), [400, 409]);
    assert.equal((await ctx.models.Order.findById(o._id)).status, 'cancelled');
  });

  test('ORD-12 (ADM-006) delivered → pending is rejected', async () => {
    const o = await newOrder();
    for (const s of ['processing', 'shipped', 'delivered']) expectStatus(assert, await setStatus(o._id, s), 200, `precondition ${s}`);
    expectStatus(assert, await setStatus(o._id, 'pending'), [400, 409]);
    assert.equal((await ctx.models.Order.findById(o._id)).status, 'delivered');
  });

  test('ORD-12b (ADM-006) pending → delivered (skipping fulfilment) is rejected', async () => {
    const o = await newOrder();
    expectStatus(assert, await setStatus(o._id, 'delivered'), [400, 409]);
  });

  test('ORD-12c (ADM-006) a delivered order cannot be cancelled', async () => {
    const o = await newOrder();
    for (const s of ['processing', 'shipped', 'delivered']) await setStatus(o._id, s);
    expectStatus(assert, await setStatus(o._id, 'cancelled'), [400, 409]);
  });

  test('ORD-16 (ADM-007) 5 concurrent valid checkouts with ample stock all succeed with unique order numbers', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 1 }])));
    const statuses = results.map((r) => r.status);
    assert.deepEqual(statuses, [201, 201, 201, 201, 201], `statuses: ${statuses}; errors: ${results.filter((r) => r.status !== 201).map((r) => r.body?.message).join(' | ')}`);
    const numbers = results.map((r) => r.body.order.orderNumber);
    assert.equal(new Set(numbers).size, 5);
  });

  test('ORD-16b (ADM-007 / SEC-K) checkout errors never expose raw MongoDB errors', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 1 }])));
    for (const r of results) {
      assert.doesNotMatch(JSON.stringify(r.body), /E11000|duplicate key|index:|collection:/, `leaked DB error: ${JSON.stringify(r.body)}`);
    }
  });

  test('ORD-06 (ADM-011) admin can fetch a single order by id', async () => {
    const o = await newOrder();
    const res = await ctx.request('GET', `/orders/${o._id}`, { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    assert.equal(res.body.order._id, o._id);
  });

  test('ORD-06b (ADM-011) single-order endpoint is admin-only', async () => {
    const o = await newOrder();
    expectStatus(assert, await ctx.request('GET', `/orders/${o._id}`, { token: fx.tokens.customer }), [403, 404]);
  });

  test('ORD-19 (ADM-011) admin order list supports server-side pagination', async () => {
    const res = await ctx.request('GET', '/orders?page=1&limit=2', { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    assert.ok(res.body.pagination, 'response should include pagination metadata');
    assert.ok(res.body.orders.length <= 2);
    assert.equal(res.body.pagination.total, await ctx.models.Order.countDocuments());
  });

  test('ORD-19b (ADM-011) admin order list supports search by order number', async () => {
    const o = await newOrder();
    const res = await ctx.request('GET', `/orders?q=${encodeURIComponent(o.orderNumber)}`, { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    assert.deepEqual(res.body.orders.map((x) => x.orderNumber), [o.orderNumber]);
  });

  // Kept LAST on purpose: with the current count-based numbering, deleting any order makes every later
  // checkout collide on orderNumber, which would contaminate the tests above.
  test('ORD-18 (ADM-007) deleting an order does not break order-number generation', async () => {
    await newOrder();
    const oldest = await ctx.models.Order.findOne().sort({ createdAt: 1 });
    await ctx.models.Order.deleteOne({ _id: oldest._id });
    const res = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 1 }]);
    expectStatus(assert, res, 201);
  });
});
