// REGRESSION — dashboard metrics (ADM-004).
// Scope note: DASH-01 (sales include cancelled/unpaid) and DASH-02 (Products card = page length) are
// calculated in client/src/pages/admin/AdminDashboard.jsx. They were verified in a browser during the audit
// and need a UI test layer (React Testing Library / Playwright) to be automated; see server/test/README.md.
// The server-side part of ADM-004 is covered here.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Dashboard data completeness (ADM-004)', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => {
    fx = await ctx.seed();
    const base = { user: fx.customer._id, items: [{ product: fx.lace._id, title: 't', price: 10, quantity: 1 }], subtotal: 10, shipping: 0, total: 10 };
    await ctx.models.Order.insertMany(Array.from({ length: 201 }, (_, i) => ({ ...base, orderNumber: `T${100000 + i}` })));
  });

  test('DASH-03 admin can obtain the true number of orders (no silent 200-order cap)', async () => {
    const res = await ctx.request('GET', '/orders', { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    const truth = await ctx.models.Order.countDocuments();
    const reported = res.body.pagination?.total ?? res.body.orders.length;
    assert.equal(reported, truth, `dashboard data source reports ${reported} orders, database has ${truth}`);
  });
});
