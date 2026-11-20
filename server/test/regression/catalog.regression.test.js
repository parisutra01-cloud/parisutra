// REGRESSION — product & category management defects (ADM-011, ADM-014, ADM-015).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Catalog management regressions', { skip: ctx.skipReason }, () => {
  let fx;
  let deletedId;
  before(async () => {
    fx = await ctx.seed();
    const made = await ctx.request('POST', '/products', { token: fx.tokens.admin, body: { title: 'To Be Deleted', price: 99, category: String(fx.laces._id) } });
    deletedId = made.body.product._id;
    await ctx.request('DELETE', `/products/${deletedId}`, { token: fx.tokens.admin });
  });

  test('PROD-27 (ADM-014) soft-deleted product is not served publicly by id → 404', async () => {
    expectStatus(assert, await ctx.request('GET', `/products/${deletedId}`), 404);
  });

  test('PROD-28 (ADM-011) admins can list inactive (soft-deleted) products', async () => {
    // Implemented in Milestone 3 as GET /api/products/manage (mirrors /api/categories/manage); the path
    // originally sketched here was /products?includeInactive=true. Assertions unchanged.
    const res = await ctx.request('GET', '/products/manage?limit=48', { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    assert.ok(res.body.products.some((p) => p._id === deletedId), 'deleted product should be visible to admins');
  });

  test('PROD-28b (ADM-011) inactive-product listing is admin-only', async () => {
    const res = await ctx.request('GET', '/products/manage?limit=48');
    expectStatus(assert, res, [200, 401, 403]);
    if (res.status === 200) assert.ok(!res.body.products.some((p) => p._id === deletedId));
  });

  test('CAT-10 (ADM-015) an admin can deactivate a category', async () => {
    const res = await ctx.request('PATCH', `/categories/${fx.laces._id}`, { token: fx.tokens.admin, body: { name: 'Laces', isActive: false } });
    expectStatus(assert, res, 200);
    assert.equal(res.body.category.isActive, false);
    assert.equal((await ctx.models.Category.findById(fx.laces._id)).isActive, false);
  });

  test('CAT-11 (ADM-015) renaming a category keeps its old URL working', async () => {
    const made = await ctx.request('POST', '/categories', { token: fx.tokens.admin, body: { name: 'Borders' } });
    expectStatus(assert, made, 201, 'fixture');
    await ctx.request('PATCH', `/categories/${made.body.category._id}`, { token: fx.tokens.admin, body: { name: 'Gold Borders' } });
    expectStatus(assert, await ctx.request('GET', '/categories/borders'), [200, 301, 308]);
  });
});
