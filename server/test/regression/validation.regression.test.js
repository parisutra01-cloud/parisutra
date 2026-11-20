// REGRESSION — input validation defects (ADM-010, ADM-013, ADM-016, ADM-018).
// Each test asserts the CORRECT behaviour; they fail until validation is added.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Product validation (ADM-010)', { skip: ctx.skipReason }, () => {
  let fx;
  let cat;
  const create = (body) => ctx.request('POST', '/products', { token: fx.tokens.admin, body });
  const notStored = async (title) => assert.equal(await ctx.models.Product.countDocuments({ title }), 0, `"${title}" must not be stored`);
  before(async () => { fx = await ctx.seed(); cat = String(fx.laces._id); });

  test('PROD-04 non-numeric price "abc" → 400 (currently 500)', async () => {
    expectStatus(assert, await create({ title: 'Bad Price', price: 'abc', category: cat }), 400);
  });

  test('PROD-06 negative price on create → 400', async () => {
    expectStatus(assert, await create({ title: 'Negative Price', price: -100, category: cat }), 400);
    await notStored('Negative Price');
  });

  test('PROD-18 negative price on update → 400 and price unchanged', async () => {
    expectStatus(assert, await ctx.request('PUT', `/products/${fx.trim._id}`, { token: fx.tokens.admin, body: { price: -1 } }), 400);
    assert.equal((await ctx.models.Product.findById(fx.trim._id)).price, 1200);
  });

  test('PROD-07 duplicate SKU → 409', async () => {
    expectStatus(assert, await create({ title: 'Dup SKU', price: 10, category: cat, sku: 'SKU-1' }), 409);
    assert.equal(await ctx.models.Product.countDocuments({ sku: 'SKU-1' }), 1);
  });

  test('PROD-09 negative stock → 400', async () => {
    expectStatus(assert, await create({ title: 'Neg Stock', price: 10, category: cat, stock: -5 }), 400);
    await notStored('Neg Stock');
  });

  test('PROD-09b negative stock on update → 400', async () => {
    expectStatus(assert, await ctx.request('PUT', `/products/${fx.lace._id}`, { token: fx.tokens.admin, body: { stock: -3 } }), 400);
  });

  test('PROD-10 malformed category id → 400 (currently 500)', async () => {
    expectStatus(assert, await create({ title: 'Bad Cat', price: 10, category: 'abc' }), 400);
  });

  test('PROD-11 non-existent category ObjectId → 400 (no orphan product)', async () => {
    expectStatus(assert, await create({ title: 'Ghost Cat', price: 10, category: String(new ctx.mongoose.Types.ObjectId()) }), 400);
    await notStored('Ghost Cat');
  });

  test('PROD-11b update to a non-existent category → 400', async () => {
    const res = await ctx.request('PUT', `/products/${fx.lace._id}`, {
      token: fx.tokens.admin, body: { category: String(new ctx.mongoose.Types.ObjectId()) },
    });
    expectStatus(assert, res, 400);
  });

  test('PROD-13 client-supplied slug is normalised (URL-safe) or rejected', async () => {
    const res = await create({ title: 'Slug Inject', slug: '../Weird Slug/<b>', price: 10, category: cat });
    assert.equal(res.crashed, false);
    if (res.status === 201) {
      assert.match(res.body.product.slug, /^[a-z0-9]+(?:-[a-z0-9]+)*$/, `stored slug "${res.body.product.slug}" is not URL-safe`);
    } else {
      expectStatus(assert, res, 400);
    }
  });

  test('PROD-14 20,000-character title → 400 (length limit)', async () => {
    expectStatus(assert, await create({ title: 'L'.repeat(20000), price: 10, category: cat }), 400);
  });

  test('PROD-15 invalid unit "kg" → 400 (currently 500)', async () => {
    expectStatus(assert, await create({ title: 'Bad Unit', price: 10, category: cat, unit: 'kg' }), 400);
  });

  test('PROD-05b price 0 → 400 with a price-specific message', async () => {
    const res = await create({ title: 'Zero Price', price: 0, category: cat });
    expectStatus(assert, res, 400);
    assert.match(res.body.message, /price/i);
    assert.doesNotMatch(res.body.message, /title/i, 'message should not blame the title when only price is invalid');
  });
});

describe('Order quantity validation (ADM-013)', { skip: ctx.skipReason }, () => {
  test('ORD-03 fractional quantity 1.5 → 400 and stock untouched', async () => {
    // Reset stock explicitly: an earlier (buggy) update may have left it negative, which would make the
    // order fail on "insufficient stock" and let this test pass for the wrong reason.
    const lace = await ctx.models.Product.findOneAndUpdate({ slug: 'test-gold-lace' }, { stock: 10, isActive: true }, { new: true });
    const token = await ctx.login('customer@parisutra.test', 'CustPass123');
    const res = await ctx.placeOrder(token, [{ productId: String(lace._id), quantity: 1.5 }]);
    expectStatus(assert, res, 400);
    assert.doesNotMatch(res.body.message, /insufficient stock/i, 'must be rejected for the fractional quantity, not stock');
    assert.equal((await ctx.models.Product.findById(lace._id)).stock, 10);
  });
});

describe('CMS & wholesale validation (ADM-016, ADM-018)', { skip: ctx.skipReason }, () => {
  let adminToken;
  before(async () => { adminToken = await ctx.login('admin@parisutra.test', 'AdminPass123'); });

  test('CMS-03 banner update with invalid placement/status enums → 400 and not persisted', async () => {
    const made = await ctx.request('POST', '/cms/banners', { token: adminToken, body: { title: 'B', imageUrl: '/x.jpg' } });
    expectStatus(assert, made, 201, 'fixture banner');
    const res = await ctx.request('PUT', `/cms/banners/${made.body.item._id}`, { token: adminToken, body: { placement: 'not-a-placement', status: 'bogus' } });
    expectStatus(assert, res, 400);
    const stored = await ctx.models.Banner.findById(made.body.item._id);
    assert.equal(stored.placement, 'homepage-hero');
    assert.equal(stored.status, 'draft');
  });

  test('CMS-07 homepage section with a key outside the enum → 400/404, nothing created', async () => {
    const res = await ctx.request('PUT', '/cms/homepage-sections/not-a-key', { token: adminToken, body: { title: 'x' } });
    expectStatus(assert, res, [400, 404]);
    const count = await ctx.mongoose.connection.db.collection('homepagesections').countDocuments({ key: 'not-a-key' });
    assert.equal(count, 0);
  });

  test('WHS-02 wholesale enquiry status outside the enum ("hacked") → 400 and not persisted', async () => {
    const made = await ctx.request('POST', '/wholesale/enquiries', { body: { companyName: 'Co', contactName: 'C', email: 'c@x.test', phone: '1' } });
    expectStatus(assert, made, 201, 'fixture enquiry');
    const res = await ctx.request('PATCH', `/wholesale/enquiries/${made.body.enquiry._id}/status`, { token: adminToken, body: { status: 'hacked' } });
    expectStatus(assert, res, 400);
    assert.equal((await ctx.models.WholesaleEnquiry.findById(made.body.enquiry._id)).status, 'new');
  });
});
