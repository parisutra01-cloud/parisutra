// Product APIs — behaviour verified as CORRECT during the audit (PROD-01/02/03/05/08/16/17/19/25/26/29/30/33/34).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Product APIs', { skip: ctx.skipReason }, () => {
  let fx;
  let cat;
  const create = (body) => ctx.request('POST', '/products', { token: fx.tokens.admin, body });
  before(async () => { fx = await ctx.seed(); cat = String(fx.laces._id); });

  test('PROD-01 create a valid product → 201 and persisted', async () => {
    const res = await create({ title: 'Test New Lace', price: 250, category: cat, stock: 5, sku: 'SKU-NEW' });
    expectStatus(assert, res, 201);
    assert.equal(res.body.product.slug, 'test-new-lace');
    const saved = await ctx.models.Product.findById(res.body.product._id);
    assert.equal(saved.price, 250);
    assert.equal(saved.stock, 5);
  });

  test('PROD-02 missing title → 400', async () => {
    expectStatus(assert, await create({ price: 250, category: cat }), 400);
  });

  test('PROD-03 missing category → 400', async () => {
    expectStatus(assert, await create({ title: 'No Category', price: 250 }), 400);
  });

  test('PROD-03b missing price → 400', async () => {
    expectStatus(assert, await create({ title: 'No Price', category: cat }), 400);
  });

  test('PROD-05 price 0 → 400', async () => {
    expectStatus(assert, await create({ title: 'Zero Price', price: 0, category: cat }), 400);
  });

  test('PROD-08 duplicate title (slug clash) → 409, no duplicate document', async () => {
    expectStatus(assert, await create({ title: 'Test Gold Lace', price: 10, category: cat }), 409);
    assert.equal(await ctx.models.Product.countDocuments({ slug: 'test-gold-lace' }), 1);
  });

  test('PROD-16 malformed JSON body → 400', async () => {
    const res = await ctx.request('POST', '/products', { token: fx.tokens.admin, rawBody: '{"title":' });
    expectStatus(assert, res, 400);
  });

  test('PROD-17 update title/price/stock/category persists and is visible on re-read', async () => {
    // Since Phase 5G.3 a stock change carries the stock the admin saw (compare-and-set).
    const { stock: expectedStock } = await ctx.models.Product.findById(fx.lace._id).lean();
    const res = await ctx.request('PUT', `/products/${fx.lace._id}`, {
      token: fx.tokens.admin,
      body: { title: 'Test Gold Lace Edited', price: 550, stock: 12, expectedStock, category: String(fx.trims._id) },
    });
    expectStatus(assert, res, 200);
    const read = await ctx.request('GET', `/products/${fx.lace._id}`);
    expectStatus(assert, read, 200);
    assert.equal(read.body.product.title, 'Test Gold Lace Edited');
    assert.equal(read.body.product.price, 550);
    assert.equal(read.body.product.stock, 12);
    assert.equal(read.body.product.category.slug, 'trims');
  });

  test('PROD-19 update a non-existent id → 404', async () => {
    const res = await ctx.request('PUT', `/products/${new ctx.mongoose.Types.ObjectId()}`, { token: fx.tokens.admin, body: { price: 5 } });
    expectStatus(assert, res, 404);
  });

  test('PROD-25/26/29 delete is a soft delete, hides product from the public list, and is repeatable', async () => {
    const made = await create({ title: 'To Be Deleted', price: 99, category: cat });
    expectStatus(assert, made, 201);
    const id = made.body.product._id;
    const del = await ctx.request('DELETE', `/products/${id}`, { token: fx.tokens.admin });
    expectStatus(assert, del, 200);
    assert.equal(del.body.product.isActive, false);
    assert.ok(await ctx.models.Product.exists({ _id: id }), 'document is kept (soft delete)');
    const list = await ctx.request('GET', '/products?limit=48');
    assert.ok(!list.body.products.some((p) => p._id === id), 'inactive product must not appear in public list');
    expectStatus(assert, await ctx.request('DELETE', `/products/${id}`, { token: fx.tokens.admin }), [200, 404]);
  });

  test('PROD-30 text search returns matching products', async () => {
    const res = await ctx.request('GET', '/products?q=Lace');
    expectStatus(assert, res, 200);
    assert.ok(res.body.products.length >= 1);
    assert.ok(res.body.products.every((p) => /lace/i.test(`${p.title} ${p.shortDescription || ''}`)));
  });

  test('PROD-30b category filter by slug', async () => {
    const res = await ctx.request('GET', '/products?categorySlug=laces');
    expectStatus(assert, res, 200);
    assert.ok(res.body.products.every((p) => p.category.slug === 'laces'));
  });

  test('PROD-30c unknown category slug returns an empty page', async () => {
    const res = await ctx.request('GET', '/products?categorySlug=does-not-exist');
    expectStatus(assert, res, 200);
    assert.deepEqual(res.body.products, []);
    assert.equal(res.body.pagination.total, 0);
  });

  test('PROD-33 page size is clamped to 48 and pagination metadata is consistent', async () => {
    const res = await ctx.request('GET', '/products?limit=5000');
    expectStatus(assert, res, 200);
    assert.equal(res.body.pagination.limit, 48);
    const truth = await ctx.models.Product.countDocuments({ isActive: true });
    assert.equal(res.body.pagination.total, truth);
    assert.equal(res.body.pagination.pages, Math.ceil(truth / 48));
  });

  test('PROD-33b pagination pages do not overlap', async () => {
    const p1 = await ctx.request('GET', '/products?limit=1&page=1');
    const p2 = await ctx.request('GET', '/products?limit=1&page=2');
    assert.notEqual(p1.body.products[0]._id, p2.body.products[0]._id);
  });

  test('PROD-34 sort=price-asc and price-desc are ordered', async () => {
    const asc = (await ctx.request('GET', '/products?sort=price-asc')).body.products.map((p) => p.price);
    const desc = (await ctx.request('GET', '/products?sort=price-desc')).body.products.map((p) => p.price);
    assert.ok(asc.every((v, i) => i === 0 || asc[i - 1] <= v), `not ascending: ${asc}`);
    assert.ok(desc.every((v, i) => i === 0 || desc[i - 1] >= v), `not descending: ${desc}`);
  });

  test('PROD-35 public slug lookup returns active products only', async () => {
    expectStatus(assert, await ctx.request('GET', '/products/slug/test-silver-trim'), 200);
    expectStatus(assert, await ctx.request('GET', '/products/slug/to-be-deleted'), 404);
  });
});
