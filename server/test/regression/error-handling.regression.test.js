// REGRESSION — ADM-001 / SEC-A: unhandled async errors crash the API process.
// Each of the nine crash scenarios verified in the audit is one test. Expected (correct) behaviour:
// the API answers with a 4xx JSON error and keeps running. Currently the process exits.
// The harness restarts the API after every crash, so each test is independent.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('ADM-001 crash regressions (API must stay up and return 4xx)', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => { fx = await ctx.seed(); });

  const stillUp = async () => {
    const health = await ctx.request('GET', '/health');
    assert.equal(health.status, 200, 'API must still be serving after the request');
  };

  test('CRASH-1 (PROD-23) anonymous GET /products/:id with malformed id → 400/404', async () => {
    expectStatus(assert, await ctx.request('GET', '/products/abc'), [400, 404]);
    await stillUp();
  });

  test('CRASH-2 (PROD-24) admin DELETE /products/:id with malformed id → 400/404', async () => {
    expectStatus(assert, await ctx.request('DELETE', '/products/abc', { token: fx.tokens.admin }), [400, 404]);
    await stillUp();
  });

  test('CRASH-3 (ORD-13) admin PATCH /orders/:id/status with malformed id → 400/404', async () => {
    const res = await ctx.request('PATCH', '/orders/abc/status', { token: fx.tokens.admin, body: { status: 'shipped' } });
    expectStatus(assert, res, [400, 404]);
    await stillUp();
  });

  test('CRASH-4 (ORD-15) customer GET /orders/my/:id with malformed id → 400/404', async () => {
    expectStatus(assert, await ctx.request('GET', '/orders/my/abc', { token: fx.tokens.customer }), [400, 404]);
    await stillUp();
  });

  test('CRASH-5 (CMS-01) admin POST /cms/banners missing required title/imageUrl → 400', async () => {
    expectStatus(assert, await ctx.request('POST', '/cms/banners', { token: fx.tokens.admin, body: { subtitle: 'x' } }), 400);
    await stillUp();
  });

  test('CRASH-6 (CMS-02) admin PUT /cms/banners/:id with malformed id → 400/404', async () => {
    expectStatus(assert, await ctx.request('PUT', '/cms/banners/abc', { token: fx.tokens.admin, body: { title: 'x' } }), [400, 404]);
    await stillUp();
  });

  test('CRASH-7 (CMS-05) admin POST /cms/announcements with empty text → 400', async () => {
    expectStatus(assert, await ctx.request('POST', '/cms/announcements', { token: fx.tokens.admin, body: {} }), 400);
    await stillUp();
  });

  test('CRASH-8 (CMS-06) admin POST /cms/blogs with duplicate slug → 409', async () => {
    const first = await ctx.request('POST', '/cms/blogs', { token: fx.tokens.admin, body: { title: 'Same Title' } });
    expectStatus(assert, first, 201, 'first blog post');
    expectStatus(assert, await ctx.request('POST', '/cms/blogs', { token: fx.tokens.admin, body: { title: 'Same Title' } }), 409);
    await stillUp();
  });

  test('CRASH-9 (WHS-03) admin PATCH /wholesale/enquiries/:id/status with malformed id → 400/404', async () => {
    const res = await ctx.request('PATCH', '/wholesale/enquiries/abc/status', { token: fx.tokens.admin, body: { status: 'closed' } });
    expectStatus(assert, res, [400, 404]);
    await stillUp();
  });
});

describe('Error-handling defects (client errors reported as 500 / wrong codes)', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => {
    await ctx.models.User.deleteMany({});
    await ctx.models.Category.deleteMany({});
    await ctx.models.Product.deleteMany({});
    fx = await ctx.seed();
  });

  test('ADM-021 (AUTH-05) login with an operator object as email → 400, not 500', async () => {
    expectStatus(assert, await ctx.request('POST', '/auth/login', { body: { email: { $ne: null }, password: 'x' } }), 400);
  });

  test('ADM-021 (AUTH-06) login with an operator object as password → 400/401, not 500', async () => {
    const res = await ctx.request('POST', '/auth/login', { body: { email: fx.admin.email, password: { $ne: null } } });
    expectStatus(assert, res, [400, 401]);
  });

  test('ADM-001 (PROD-20) PUT /products/:id with malformed id → 400/404, not 500', async () => {
    expectStatus(assert, await ctx.request('PUT', '/products/abc', { token: fx.tokens.admin, body: { price: 5 } }), [400, 404]);
  });

  test('SEC-H (PROD-31) search containing regex metacharacters → 200 (input escaped), not 500', async () => {
    const res = await ctx.request('GET', '/products?categorySlug=laces&q=(');
    expectStatus(assert, res, 200);
  });

  test('ADM-016 (CMS-08) DELETE of a non-existent FAQ → 404, not {ok:true}', async () => {
    expectStatus(assert, await ctx.request('DELETE', `/cms/faqs/${new ctx.mongoose.Types.ObjectId()}`, { token: fx.tokens.admin }), 404);
  });

  test('ADM-016 DELETE of a non-existent banner / announcement / blog → 404', async () => {
    const id = String(new ctx.mongoose.Types.ObjectId());
    for (const kind of ['banners', 'announcements', 'blogs']) {
      expectStatus(assert, await ctx.request('DELETE', `/cms/${kind}/${id}`, { token: fx.tokens.admin }), 404, `/cms/${kind}`);
    }
  });
});
