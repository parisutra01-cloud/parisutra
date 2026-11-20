// REGRESSION — security findings (SEC-D, SEC-E, SEC-F, SEC-G, SEC-I, SEC-J, SEC-M).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Security regressions', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => { fx = await ctx.seed(); });

  test('PROD-21 (SEC-D) public product detail does not expose costPrice', async () => {
    const res = await ctx.request('GET', `/products/${fx.lace._id}`);
    expectStatus(assert, res, 200);
    assert.equal(res.body.product.costPrice, undefined);
  });

  test('PROD-21b (SEC-D) public slug lookup does not expose costPrice', async () => {
    const res = await ctx.request('GET', '/products/slug/test-gold-lace');
    expectStatus(assert, res, 200);
    assert.equal(res.body.product.costPrice, undefined);
  });

  test('PROD-22 (SEC-D) public product list does not expose costPrice', async () => {
    const res = await ctx.request('GET', '/products');
    expectStatus(assert, res, 200);
    assert.ok(res.body.products.every((p) => p.costPrice === undefined), 'costPrice present in public list');
  });

  test('PROD-12 (SEC-E) product create ignores server-controlled fields (rating, reviewCount, createdAt)', async () => {
    const res = await ctx.request('POST', '/products', {
      token: fx.tokens.admin,
      body: { title: 'Mass Assign', price: 10, category: String(fx.laces._id), rating: 5, reviewCount: 99999, createdAt: '2001-01-01T00:00:00.000Z' },
    });
    expectStatus(assert, res, 201);
    assert.notEqual(res.body.product.reviewCount, 99999);
    assert.notEqual(new Date(res.body.product.createdAt).getUTCFullYear(), 2001);
  });

  test('SEC-E product update ignores server-controlled fields (reviewCount)', async () => {
    const res = await ctx.request('PUT', `/products/${fx.lace._id}`, { token: fx.tokens.admin, body: { reviewCount: 4242 } });
    assert.equal(res.crashed, false);
    assert.notEqual((await ctx.models.Product.findById(fx.lace._id)).reviewCount, 4242);
  });

  test('WHS-01 (SEC-F) anonymous wholesale enquiry cannot set status or user', async () => {
    const res = await ctx.request('POST', '/wholesale/enquiries', {
      body: { companyName: 'Co', contactName: 'C', email: 'c@x.test', phone: '1', status: 'closed', user: String(fx.customer._id) },
    });
    expectStatus(assert, res, 201);
    const stored = await ctx.models.WholesaleEnquiry.findById(res.body.enquiry._id);
    assert.equal(stored.status, 'new');
    assert.equal(stored.user, undefined);
  });

  test('PROD-32 (SEC-G) query operators in filters are not passed to MongoDB', async () => {
    const res = await ctx.request('GET', `/products?category[$ne]=${fx.laces._id}`);
    assert.equal(res.crashed, false);
    if (res.status === 200) {
      assert.ok(
        res.body.products.length === 0,
        `operator was interpreted: returned products from categories ${res.body.products.map((p) => p.category?.slug)}`,
      );
    } else {
      expectStatus(assert, res, 400);
    }
  });

  test('SEC-G order status filter rejects operator objects', async () => {
    // Needs at least one non-cancelled order, otherwise an empty result would pass vacuously.
    const placed = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 1 }]);
    expectStatus(assert, placed, 201, 'fixture order');
    const res = await ctx.request('GET', '/orders?status[$ne]=cancelled', { token: fx.tokens.admin });
    expectStatus(assert, res, [200, 400]);
    if (res.status === 200) assert.equal(res.body.orders.length, 0, 'status[$ne] must not act as an operator');
  });

  test('SEC-I (CORS) arbitrary *.vercel.app origins are not allowed', async () => {
    const res = await fetch(`${ctx.base}/health`, { headers: { Origin: 'https://attacker-site.vercel.app' } });
    assert.notEqual(res.headers.get('access-control-allow-origin'), 'https://attacker-site.vercel.app');
  });

  test('SEC-I (CORS) the configured client origin is still allowed', async () => {
    const res = await fetch(`${ctx.base}/health`, { headers: { Origin: 'http://localhost:5173' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  test('SEC-J security headers present and X-Powered-By removed', async () => {
    const res = await fetch(`${ctx.base}/health`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
  });

  test('SEC-M banner ctaLink rejects javascript: URLs', async () => {
    const res = await ctx.request('POST', '/cms/banners', {
      token: fx.tokens.admin, body: { title: 'XSS', imageUrl: '/x.jpg', ctaLink: 'javascript:alert(1)' },
    });
    expectStatus(assert, res, 400);
  });
});
