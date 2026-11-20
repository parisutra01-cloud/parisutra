// Category APIs — behaviour verified as CORRECT during the audit (CAT-01…09).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Category APIs', { skip: ctx.skipReason }, () => {
  let fx;
  const admin = (method, path, body) => ctx.request(method, path, { token: fx.tokens.admin, body });
  before(async () => { fx = await ctx.seed(); });

  test('CAT-01 create a valid category → 201 with generated slug and next sortOrder', async () => {
    const res = await admin('POST', '/categories', { name: '  Pom   Poms ' });
    expectStatus(assert, res, 201);
    assert.equal(res.body.category.name, 'Pom Poms');
    assert.equal(res.body.category.slug, 'pom-poms');
    assert.equal(res.body.category.sortOrder, 3);
  });

  test('CAT-02 duplicate name (case-insensitive) → 409', async () => {
    expectStatus(assert, await admin('POST', '/categories', { name: 'pom poms' }), 409);
    assert.equal(await ctx.models.Category.countDocuments({ slug: 'pom-poms' }), 1);
  });

  test('CAT-03 empty / whitespace name → 400', async () => {
    expectStatus(assert, await admin('POST', '/categories', { name: '   ' }), 400);
    expectStatus(assert, await admin('POST', '/categories', {}), 400);
  });

  test('CAT-04 path-like or too-short names → 400', async () => {
    expectStatus(assert, await admin('POST', '/categories', { name: '../x' }), 400);
    expectStatus(assert, await admin('POST', '/categories', { name: 'Laces/Gold' }), 400);
    expectStatus(assert, await admin('POST', '/categories', { name: 'A' }), 400);
  });

  test('CAT-05 rename persists name and slug', async () => {
    const made = await admin('POST', '/categories', { name: 'Tassels' });
    const res = await admin('PATCH', `/categories/${made.body.category._id}`, { name: 'Silk Tassels' });
    expectStatus(assert, res, 200);
    assert.equal(res.body.category.name, 'Silk Tassels');
    assert.equal(res.body.category.slug, 'silk-tassels');
  });

  test('CAT-06 rename to an existing name → 409', async () => {
    expectStatus(assert, await admin('PATCH', `/categories/${fx.laces._id}`, { name: 'Trims' }), 409);
  });

  test('CAT-07 delete a category that still has products → 409, nothing removed', async () => {
    expectStatus(assert, await admin('DELETE', `/categories/${fx.trims._id}`), 409);
    assert.ok(await ctx.models.Category.exists({ _id: fx.trims._id }));
  });

  test('CAT-08 delete an empty category → 200 and removed', async () => {
    const made = await admin('POST', '/categories', { name: 'Temp Empty' });
    expectStatus(assert, await admin('DELETE', `/categories/${made.body.category._id}`), 200);
    assert.equal(await ctx.models.Category.exists({ _id: made.body.category._id }), null);
  });

  test('CAT-09 malformed / unknown ids → 404 (no crash)', async () => {
    expectStatus(assert, await admin('DELETE', '/categories/abc'), 404);
    expectStatus(assert, await admin('PATCH', '/categories/abc', { name: 'Whatever' }), 404);
    expectStatus(assert, await admin('PATCH', `/categories/${new ctx.mongoose.Types.ObjectId()}`, { name: 'Whatever' }), 404);
  });

  test('CAT-12 admin /manage lists inactive categories; public list hides them', async () => {
    await ctx.models.Category.create({ name: 'Hidden', slug: 'hidden', isActive: false });
    const manage = await admin('GET', '/categories/manage');
    expectStatus(assert, manage, 200);
    assert.ok(manage.body.categories.some((c) => c.slug === 'hidden'));
    const pub = await ctx.request('GET', '/categories');
    assert.ok(!pub.body.categories.some((c) => c.slug === 'hidden'));
    expectStatus(assert, await ctx.request('GET', '/categories/hidden'), 404);
  });
});
