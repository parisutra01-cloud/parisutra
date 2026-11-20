// Server-side RBAC: every admin endpoint must reject anonymous (401) and customer (403) callers.
// Verified as CORRECT during the audit (AUTHZ-NOAUTH-01…25, AUTHZ-CUST-01…25).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Admin authorization (RBAC enforced by the API, not the React UI)', { skip: ctx.skipReason }, () => {
  let fx;
  let endpoints;
  before(async () => {
    fx = await ctx.seed();
    const oid = () => String(new ctx.mongoose.Types.ObjectId());
    endpoints = [
      ['GET', '/categories/manage'],
      ['POST', '/categories', { name: 'Hack' }],
      ['PATCH', `/categories/${fx.laces._id}`, { name: 'Hack' }],
      ['DELETE', `/categories/${fx.trims._id}`],
      ['POST', '/products', { title: 'x', price: 1, category: String(fx.laces._id) }],
      ['PUT', `/products/${fx.lace._id}`, { price: 1 }],
      ['DELETE', `/products/${fx.lace._id}`],
      ['GET', '/orders'],
      ['PATCH', `/orders/${oid()}/status`, { status: 'shipped' }],
      ['GET', '/contact'],
      ['GET', '/wholesale/enquiries'],
      ['PATCH', `/wholesale/enquiries/${oid()}/status`, { status: 'closed' }],
      ['GET', '/uploads/config'],
      ['POST', '/uploads/sign', { categoryId: String(fx.laces._id) }],
      ['GET', '/uploads/assets'],
      ['POST', '/uploads/assets', {}],
      ['DELETE', `/uploads/assets/${oid()}`],
      ['GET', '/cms/banners'],
      ['POST', '/cms/banners', {}],
      ['GET', '/cms/announcements'],
      ['GET', '/cms/faqs'],
      ['GET', '/cms/blogs'],
      ['GET', '/cms/homepage-sections'],
      ['PUT', '/cms/homepage-sections/promo-banner', { title: 'x' }],
      ['GET', '/cms/stats'],
    ];
  });

  test('AUTHZ-NOAUTH-01…25 every admin endpoint returns 401 without a token', async () => {
    assert.equal(endpoints.length, 25);
    for (const [method, path, body] of endpoints) {
      const res = await ctx.request(method, path, { body });
      expectStatus(assert, res, 401, `${method} ${path} (anonymous)`);
    }
  });

  test('AUTHZ-CUST-01…25 every admin endpoint returns 403 for a customer token', async () => {
    for (const [method, path, body] of endpoints) {
      const res = await ctx.request(method, path, { token: fx.tokens.customer, body });
      expectStatus(assert, res, 403, `${method} ${path} (customer)`);
    }
  });

  test('AUTHZ-DATA customer-scoped probes did not change any data', async () => {
    const lace = await ctx.models.Product.findById(fx.lace._id);
    assert.equal(lace.price, 500);
    assert.equal(lace.isActive, true);
    assert.equal(await ctx.models.Category.countDocuments(), 2);
    assert.equal((await ctx.models.Category.findById(fx.laces._id)).name, 'Laces');
  });

  test('AUTHZ-IDOR customer cannot read another customer\'s order', async () => {
    const other = await ctx.createUser({ email: 'other@parisutra.test' });
    const placed = await ctx.placeOrder(other.token, [{ productId: String(fx.lace._id), quantity: 1 }]);
    expectStatus(assert, placed, 201);
    const res = await ctx.request('GET', `/orders/my/${placed.body.order._id}`, { token: fx.tokens.customer });
    expectStatus(assert, res, 404);
    const cancel = await ctx.request('PATCH', `/orders/my/${placed.body.order._id}/cancel`, { token: fx.tokens.customer });
    expectStatus(assert, cancel, 404);
  });
});
