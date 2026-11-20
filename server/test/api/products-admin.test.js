// Admin product management API (Milestone 3): listing, detail, create, update, delete, validation.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Admin product management API', { skip: ctx.skipReason }, () => {
  let fx;
  let cat;
  const admin = (method, path, body) => ctx.request(method, path, { token: fx.tokens.admin, body });
  const manage = async (query = '') => {
    const res = await admin('GET', `/products/manage${query}`);
    expectStatus(assert, res, 200, `manage${query}`);
    return res.body;
  };
  before(async () => {
    fx = await ctx.seed();
    cat = String(fx.laces._id);
    const { Product } = ctx.models;
    // lace: stock 10 (alert 10 → low), trim: stock 3 (low); add an out-of-stock, a hidden and a healthy product.
    await Product.create({ title: 'Out Of Stock Pom', slug: 'out-of-stock-pom', sku: 'POM-OUT', category: fx.trims._id, price: 90, stock: 0 });
    await Product.create({ title: 'Hidden Draft Lace', slug: 'hidden-draft-lace', sku: 'DRAFT-1', category: fx.laces._id, price: 700, stock: 50, isActive: false, costPrice: 99 });
    await Product.create({ title: 'Plenty Tassel', slug: 'plenty-tassel', sku: 'TAS-9', category: fx.laces._id, price: 40, stock: 500 });
  });

  test('PM-01 /products/manage is admin-only', async () => {
    expectStatus(assert, await ctx.request('GET', '/products/manage'), 401);
    expectStatus(assert, await ctx.request('GET', '/products/manage', { token: fx.tokens.customer }), 403);
    expectStatus(assert, await ctx.request('GET', `/products/manage/${fx.lace._id}`, { token: fx.tokens.customer }), 403);
  });

  test('PM-02 admin list includes inactive products and costPrice; KPI stats match the database', async () => {
    const body = await manage('?limit=100');
    assert.equal(body.pagination.total, 5);
    const draft = body.products.find((p) => p.slug === 'hidden-draft-lace');
    assert.equal(draft.isActive, false);
    assert.equal(draft.costPrice, 99);
    assert.deepEqual(body.stats, { total: 5, active: 4, inactive: 1, lowStock: 2, outOfStock: 1 });
  });

  test('PM-03 search matches title, SKU (case-insensitive) and slug; regex characters are literal', async () => {
    assert.deepEqual((await manage('?q=tassel')).products.map((p) => p.slug), ['plenty-tassel']);
    assert.deepEqual((await manage('?q=draft-1')).products.map((p) => p.slug), ['hidden-draft-lace']);
    assert.deepEqual((await manage('?q=out-of-stock')).products.map((p) => p.slug), ['out-of-stock-pom']);
    assert.equal((await manage('?q=(')).pagination.total, 0);
    assert.equal((await manage('?q=.*')).pagination.total, 0);
  });

  test('PM-04 filters: category, status and stock level', async () => {
    const byCat = await manage(`?category=${fx.trims._id}`);
    assert.ok(byCat.products.every((p) => p.category.slug === 'trims'));
    assert.equal(byCat.pagination.total, 2);
    assert.deepEqual((await manage('?status=inactive')).products.map((p) => p.slug), ['hidden-draft-lace']);
    assert.equal((await manage('?status=active')).pagination.total, 4);
    assert.deepEqual((await manage('?stock=out')).products.map((p) => p.slug), ['out-of-stock-pom']);
    assert.deepEqual((await manage('?stock=low&sort=title-asc')).products.map((p) => p.slug), ['test-gold-lace', 'test-silver-trim']);
    assert.deepEqual((await manage('?stock=in&sort=title-asc')).products.map((p) => p.slug), ['hidden-draft-lace', 'plenty-tassel']);
  });

  test('PM-05 sorting and pagination (stable, non-overlapping, consistent totals)', async () => {
    const asc = (await manage('?sort=price-asc&limit=100')).products.map((p) => p.price);
    assert.deepEqual(asc, [...asc].sort((a, b) => a - b));
    const stockDesc = (await manage('?sort=stock-desc&limit=100')).products.map((p) => p.stock);
    assert.deepEqual(stockDesc, [...stockDesc].sort((a, b) => b - a));
    const pages = [];
    for (let page = 1; page <= 3; page += 1) {
      const body = await manage(`?limit=2&page=${page}&sort=price-asc`);
      assert.equal(body.pagination.pages, 3);
      pages.push(...body.products.map((p) => p._id));
    }
    assert.equal(new Set(pages).size, 5, 'every product appears exactly once across pages');
    assert.equal((await manage('?limit=5000')).pagination.limit, 100);
  });

  test('PM-06 invalid filters are rejected; operator objects are ignored', async () => {
    expectStatus(assert, await admin('GET', '/products/manage?category=abc'), 400);
    expectStatus(assert, await admin('GET', '/products/manage?status=deleted'), 400);
    expectStatus(assert, await admin('GET', '/products/manage?stock=lots'), 400);
    const res = await admin('GET', '/products/manage?q[$ne]=x');
    expectStatus(assert, res, 200);
    assert.equal(res.body.pagination.total, 5);
  });

  test('PM-07 admin detail returns any status with costPrice; bad and unknown ids handled', async () => {
    const draft = await ctx.models.Product.findOne({ slug: 'hidden-draft-lace' });
    const res = await admin('GET', `/products/manage/${draft._id}`);
    expectStatus(assert, res, 200);
    assert.equal(res.body.product.costPrice, 99);
    expectStatus(assert, await admin('GET', '/products/manage/abc'), 400);
    expectStatus(assert, await admin('GET', `/products/manage/${new ctx.mongoose.Types.ObjectId()}`), 404);
  });

  test('PM-08 create persists every editable field, derives the slug and ignores unknown/server fields', async () => {
    const res = await admin('POST', '/products', {
      title: '  Royal Velvet Border  ', sku: 'RVB-01', category: cat, shortDescription: 'Soft velvet', description: 'Long text',
      price: '349.5', comparePrice: 499, costPrice: 120, unit: 'Piece', stock: '25', lowStockAlert: 5, trackStock: true,
      material: ['Velvet', 'Velvet', ' Zari '], colors: ['Maroon'], styles: ['Bridal'], images: [{ url: '/images/product-3.jpg' }],
      isActive: true, isFeatured: true, isNewArrival: false, metaTitle: 'Royal Velvet', metaDescription: 'Buy now',
      rating: 5, reviewCount: 999, variations: [{ name: 'x' }], _id: '64b7f0c2a1b2c3d4e5f60718', hacker: true,
    });
    expectStatus(assert, res, 201);
    const saved = await ctx.models.Product.findById(res.body.product._id).lean();
    assert.equal(saved.title, 'Royal Velvet Border');
    assert.equal(saved.slug, 'royal-velvet-border');
    assert.equal(saved.price, 349.5);
    assert.equal(saved.stock, 25);
    assert.equal(saved.unit, 'piece');
    assert.deepEqual(saved.material, ['Velvet', 'Zari']);
    assert.deepEqual(saved.images.map((i) => [i.url, i.isMain]), [['/images/product-3.jpg', true]]);
    assert.equal(saved.isFeatured, true);
    assert.equal(saved.reviewCount, 0);
    assert.equal(saved.rating, 4.5);
    assert.deepEqual(saved.variations, []);
    assert.notEqual(String(saved._id), '64b7f0c2a1b2c3d4e5f60718');
    assert.equal(saved.hacker, undefined);
  });

  test('PM-09 validation errors are returned per field with a readable summary', async () => {
    const res = await admin('POST', '/products', { title: '', price: -1, stock: 1.5, unit: 'kg', category: 'abc', trackStock: 'yes' });
    expectStatus(assert, res, 400);
    assert.equal(res.body.message, 'Please fix 6 fields');
    assert.deepEqual(Object.keys(res.body.errors).sort(), ['category', 'price', 'stock', 'title', 'trackStock', 'unit']);
    const single = await admin('POST', '/products', { title: 'Fine', price: 10, category: cat, stock: -2 });
    expectStatus(assert, single, 400);
    assert.equal(single.body.message, 'Stock cannot be negative');
  });

  test('PM-10 compare price must not be below the selling price', async () => {
    const res = await admin('POST', '/products', { title: 'Cheap Compare', price: 100, comparePrice: 50, category: cat });
    expectStatus(assert, res, 400);
    assert.ok(res.body.errors.comparePrice);
    const upd = await admin('PUT', `/products/${fx.lace._id}`, { comparePrice: 1 });
    expectStatus(assert, upd, 400, 'compare price below existing price on update');
  });

  test('PM-11 SKU uniqueness is case-insensitive on create and update', async () => {
    const dup = await admin('POST', '/products', { title: 'Dup Sku Lower', price: 10, category: cat, sku: 'sku-1' });
    expectStatus(assert, dup, 409);
    assert.equal(dup.body.errors.sku, 'SKU already exists');
    expectStatus(assert, await admin('PUT', `/products/${fx.trim._id}`, { sku: 'SKU-1' }), 409);
    expectStatus(assert, await admin('PUT', `/products/${fx.lace._id}`, { sku: 'SKU-1' }), 200, 'keeping its own SKU is fine');
  });

  test('PM-12 partial update changes only the sent fields; blank optional fields are cleared', async () => {
    const before = await ctx.models.Product.findById(fx.trim._id).lean();
    const res = await admin('PUT', `/products/${fx.trim._id}`, { price: 1300, sku: '', comparePrice: '' });
    expectStatus(assert, res, 200);
    const after = await ctx.models.Product.findById(fx.trim._id).lean();
    assert.equal(after.price, 1300);
    assert.equal(after.sku, undefined);
    assert.equal(after.title, before.title);
    assert.equal(after.stock, before.stock);
    assert.equal(after.costPrice, before.costPrice);
  });

  test('PM-13 update errors: slug conflict 409, missing category 400, unknown id 404, malformed id 400', async () => {
    expectStatus(assert, await admin('PUT', `/products/${fx.trim._id}`, { slug: 'Test Gold Lace' }), 409);
    expectStatus(assert, await admin('PUT', `/products/${fx.trim._id}`, { category: String(new ctx.mongoose.Types.ObjectId()) }), 400);
    expectStatus(assert, await admin('PUT', `/products/${new ctx.mongoose.Types.ObjectId()}`, { price: 5 }), 404);
    expectStatus(assert, await admin('PUT', '/products/abc', { price: 5 }), 400);
    expectStatus(assert, await admin('DELETE', '/products/abc'), 400);
    expectStatus(assert, await admin('DELETE', `/products/${new ctx.mongoose.Types.ObjectId()}`), 404);
  });

  test('PM-14 delete hides the product from the store; it stays listable and can be restored', async () => {
    const made = await admin('POST', '/products', { title: 'Lifecycle Lace', price: 55, category: cat, stock: 4 });
    const id = made.body.product._id;
    expectStatus(assert, await ctx.request('GET', '/products/slug/lifecycle-lace'), 200, 'visible before delete');
    expectStatus(assert, await admin('DELETE', `/products/${id}`), 200);
    expectStatus(assert, await ctx.request('GET', `/products/${id}`), 404);
    expectStatus(assert, await ctx.request('GET', '/products/slug/lifecycle-lace'), 404);
    assert.ok((await manage('?status=inactive')).products.some((p) => p._id === id));
    expectStatus(assert, await admin('PUT', `/products/${id}`, { isActive: true }), 200);
    expectStatus(assert, await ctx.request('GET', '/products/slug/lifecycle-lace'), 200, 'visible again after restore');
  });

  test('PM-15 public endpoints keep their contract and hide internal fields', async () => {
    const list = await ctx.request('GET', '/products?categorySlug=laces&sort=price-asc&limit=2');
    expectStatus(assert, list, 200);
    assert.ok(list.body.pagination && list.body.products.length <= 2);
    assert.ok(list.body.products.every((p) => p.costPrice === undefined && p.isActive === true));
    expectStatus(assert, await ctx.request('GET', '/products?category='), 200, 'empty category param means no filter');
    expectStatus(assert, await ctx.request('GET', '/products?categorySlug[$ne]=x'), 200);
  });
});
