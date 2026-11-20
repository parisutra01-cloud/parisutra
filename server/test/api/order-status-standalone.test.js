// Milestone 5D: on a standalone MongoDB (no transactions) cancellation must refuse clearly instead of
// falling back to a non-atomic sequence. Production (Atlas) is always a replica set.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url, { replicaSet: false });
after(() => ctx.close());

describe('Order cancellation without transaction support', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => {
    fx = await ctx.seed();
    await ctx.models.Product.updateOne({ _id: fx.lace._id }, { stock: 10 });
  });

  test('OS-SA-01 cancellation returns 503 and changes nothing; other transitions still work', async () => {
    const placed = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 3 }]);
    expectStatus(assert, placed, 201);
    const id = placed.body.order._id;
    for (const res of [
      await ctx.request('PATCH', `/orders/${id}/status`, { token: fx.tokens.admin, body: { status: 'cancelled' } }),
      await ctx.request('PATCH', `/orders/my/${id}/cancel`, { token: fx.tokens.customer }),
    ]) {
      expectStatus(assert, res, 503);
      assert.match(res.body.message, /replica set/);
    }
    assert.equal((await ctx.models.Order.findById(id)).status, 'pending');
    assert.equal((await ctx.models.Product.findById(fx.lace._id)).stock, 7);
    expectStatus(assert, await ctx.request('PATCH', `/orders/${id}/status`, { token: fx.tokens.admin, body: { status: 'processing' } }), 200);
  });
});
