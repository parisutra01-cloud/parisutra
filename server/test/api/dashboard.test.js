// Dashboard data contract — the server data the admin dashboard depends on, verified correct today.
// (The dashboard's own miscalculations live in client code; see regression/dashboard.regression.test.js.)
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Dashboard data contract', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => {
    fx = await ctx.seed();
    for (let i = 0; i < 8; i += 1) {
      await ctx.models.Product.create({ title: `Bulk ${i}`, slug: `bulk-${i}`, category: fx.laces._id, price: 10 + i, stock: 5 });
    }
    await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 1 }]);
  });

  test('DASH-05 /products pagination.total equals the true active product count (usable for the Products KPI)', async () => {
    const res = await ctx.request('GET', '/products?limit=6');
    expectStatus(assert, res, 200);
    assert.equal(res.body.products.length, 6);
    assert.equal(res.body.pagination.total, await ctx.models.Product.countDocuments({ isActive: true }));
  });

  test('DASH-06 admin orders expose status, paymentStatus and total needed for revenue rules', async () => {
    const res = await ctx.request('GET', '/orders', { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    for (const o of res.body.orders) {
      assert.ok(['pending', 'processing', 'shipped', 'delivered', 'cancelled'].includes(o.status));
      assert.ok(['pending', 'paid', 'failed'].includes(o.paymentStatus));
      assert.equal(typeof o.total, 'number');
    }
  });
});
