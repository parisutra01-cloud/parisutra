// REGRESSION — inventory consistency (ADM-005, ADM-012).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Inventory consistency', { skip: ctx.skipReason }, () => {
  let fx;
  const stockOf = async (id) => (await ctx.models.Product.findById(id)).stock;
  before(async () => { fx = await ctx.seed(); });

  test('ORD-10 (ADM-005) admin cancelling an order restores the reserved stock', async () => {
    await ctx.models.Product.updateOne({ _id: fx.trim._id }, { stock: 3 });
    const placed = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.trim._id), quantity: 2 }]);
    expectStatus(assert, placed, 201, 'fixture order');
    assert.equal(await stockOf(fx.trim._id), 1, 'precondition: stock deducted');
    expectStatus(assert, await ctx.request('PATCH', `/orders/${placed.body.order._id}/status`, { token: fx.tokens.admin, body: { status: 'cancelled' } }), 200);
    assert.equal(await stockOf(fx.trim._id), 3);
  });

  test('INV-01 (ADM-005) customer cancelling their own order restores stock', async () => {
    await ctx.models.Product.updateOne({ _id: fx.lace._id }, { stock: 10 });
    const placed = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 4 }]);
    expectStatus(assert, placed, 201, 'fixture order');
    expectStatus(assert, await ctx.request('PATCH', `/orders/my/${placed.body.order._id}/cancel`, { token: fx.tokens.customer }), 200);
    assert.equal(await stockOf(fx.lace._id), 10);
  });

  test('INV-02 (ADM-005/006) repeating "cancelled" does not restore stock twice', async () => {
    await ctx.models.Product.updateOne({ _id: fx.lace._id }, { stock: 10 });
    const placed = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 2 }]);
    const id = placed.body.order._id;
    await ctx.request('PATCH', `/orders/${id}/status`, { token: fx.tokens.admin, body: { status: 'cancelled' } });
    await ctx.request('PATCH', `/orders/${id}/status`, { token: fx.tokens.admin, body: { status: 'cancelled' } });
    assert.equal(await stockOf(fx.lace._id), 10, 'stock must equal the pre-order level exactly once');
  });

  test('INV-03 (ADM-012) concurrent checkouts never oversell (stock never negative, successes ≤ stock)', async () => {
    // NOTE: today this can pass "by accident": concurrent checkouts mostly fail on the order-number
    // collision (ADM-007) before stock is touched. It becomes a real guard once ADM-007 is fixed.
    await ctx.models.Product.updateOne({ _id: fx.trim._id }, { stock: 2 });
    const results = await Promise.all(Array.from({ length: 6 }, () => ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.trim._id), quantity: 1 }])));
    const ok = results.filter((r) => r.status === 201).length;
    const stock = await stockOf(fx.trim._id);
    assert.ok(stock >= 0, `stock went negative: ${stock}`);
    assert.ok(ok <= 2, `${ok} orders succeeded for 2 units`);
    assert.equal(stock, 2 - ok, 'stock must equal initial stock minus successful orders');
  });

  test('INV-04 (ADM-012) a failed order (insufficient stock on a later line) leaves stock unchanged', async () => {
    await ctx.models.Product.updateOne({ _id: fx.lace._id }, { stock: 10 });
    await ctx.models.Product.updateOne({ _id: fx.trim._id }, { stock: 0 });
    const res = await ctx.placeOrder(fx.tokens.customer, [
      { productId: String(fx.lace._id), quantity: 1 },
      { productId: String(fx.trim._id), quantity: 1 },
    ]);
    expectStatus(assert, res, 400);
    assert.equal(await stockOf(fx.lace._id), 10);
  });
});
