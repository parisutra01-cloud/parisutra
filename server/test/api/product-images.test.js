// Product image management with the existing secure Cloudinary flow, against a LOCAL mock Cloudinary API.
// No request reaches Cloudinary; no real asset can be touched.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';
import { startCloudinaryMock } from '../helpers/cloudinaryMock.js';

const cloudinary = await startCloudinaryMock();
const ctx = await createTestContext(import.meta.url, { extraEnv: cloudinary.env });
after(async () => { await ctx.close(); await cloudinary.close(); });

describe('Product images via Cloudinary (mocked)', { skip: ctx.skipReason }, () => {
  let fx;
  const admin = (method, path, body) => ctx.request(method, path, { token: fx.tokens.admin, body });
  const register = (publicId, categoryId = fx.laces._id) => admin('POST', '/uploads/assets', { publicId, categoryId: String(categoryId) });
  before(async () => { fx = await ctx.seed(); });

  test('IMG-01 an uploaded image is verified with Cloudinary and registered in the media library', async () => {
    const r = cloudinary.addResource('parisutra-test/laces/img-1', { tags: ['cat_laces'] });
    const res = await register('parisutra-test/laces/img-1');
    expectStatus(assert, res, 201);
    assert.equal(res.body.asset.secureUrl, r.secure_url);
    assert.deepEqual(cloudinary.calls.filter((c) => c.type === 'unexpected'), []);
  });

  test('IMG-02 a product can be created with uploaded images; exactly one main image is kept', async () => {
    const a = cloudinary.addResource('parisutra-test/laces/img-2', { tags: ['cat_laces'] });
    const b = cloudinary.addResource('parisutra-test/laces/img-3', { tags: ['cat_laces'] });
    await register('parisutra-test/laces/img-2');
    await register('parisutra-test/laces/img-3');
    const res = await admin('POST', '/products', {
      title: 'Image Product', price: 100, category: String(fx.laces._id),
      images: [{ url: a.secure_url, isMain: true }, { url: b.secure_url, isMain: true }, { url: a.secure_url }],
    });
    expectStatus(assert, res, 201);
    assert.deepEqual(res.body.product.images.map((i) => [i.url, i.isMain]), [[a.secure_url, true], [b.secure_url, false]]);
  });

  test('IMG-03 foreign or unsafe image URLs are rejected', async () => {
    for (const url of [
      'https://evil.example/x.jpg',
      'http://res.cloudinary.com/parisutra-test-fake-cloud/image/upload/x.png',
      'https://res.cloudinary.com/some-other-cloud/image/upload/x.png',
      'javascript:alert(1)',
      '/images/../../etc/passwd',
    ]) {
      const res = await admin('POST', '/products', { title: `Bad Image ${url.length}`, price: 10, category: String(fx.laces._id), images: [{ url }] });
      expectStatus(assert, res, 400, url);
      assert.ok(res.body.errors?.images, `errors.images expected for ${url}`);
    }
  });

  test('IMG-04 replacing a product image keeps the old asset in the media library (no destroy on save)', async () => {
    const oldImg = cloudinary.addResource('parisutra-test/laces/old', { tags: ['cat_laces'] });
    const newImg = cloudinary.addResource('parisutra-test/laces/new', { tags: ['cat_laces'] });
    await register('parisutra-test/laces/old');
    await register('parisutra-test/laces/new');
    const made = await admin('POST', '/products', { title: 'Replace Me', price: 10, category: String(fx.laces._id), images: [{ url: oldImg.secure_url }] });
    cloudinary.reset();
    const res = await admin('PUT', `/products/${made.body.product._id}`, { images: [{ url: newImg.secure_url, isMain: true }] });
    expectStatus(assert, res, 200);
    assert.deepEqual(res.body.product.images.map((i) => i.url), [newImg.secure_url]);
    assert.deepEqual(cloudinary.destroyed(), [], 'saving a product must never delete Cloudinary assets');
  });

  test('IMG-05 an image still used by a product cannot be deleted (409, nothing destroyed)', async () => {
    const used = await ctx.mongoose.connection.db.collection('mediaassets').findOne({ publicId: 'parisutra-test/laces/new' });
    cloudinary.reset();
    const res = await admin('DELETE', `/uploads/assets/${used._id}`);
    expectStatus(assert, res, 409);
    assert.match(res.body.message, /1 product/);
    assert.deepEqual(cloudinary.destroyed(), []);
    assert.ok(await ctx.mongoose.connection.db.collection('mediaassets').findOne({ _id: used._id }));
  });

  test('IMG-06 an unused image can be deleted: destroyed in Cloudinary and removed from the library', async () => {
    const unused = await ctx.mongoose.connection.db.collection('mediaassets').findOne({ publicId: 'parisutra-test/laces/old' });
    cloudinary.reset();
    const res = await admin('DELETE', `/uploads/assets/${unused._id}`);
    expectStatus(assert, res, 200);
    assert.deepEqual(cloudinary.destroyed(), ['parisutra-test/laces/old']);
    assert.equal(await ctx.mongoose.connection.db.collection('mediaassets').findOne({ _id: unused._id }), null);
  });

  test('IMG-07 upload failure: a file that never reached Cloudinary is rejected and not registered', async () => {
    const res = await register('parisutra-test/laces/never-uploaded');
    expectStatus(assert, res, 400);
    assert.match(res.body.message, /not found/i);
    assert.equal(await ctx.mongoose.connection.db.collection('mediaassets').findOne({ publicId: 'parisutra-test/laces/never-uploaded' }), null);
  });

  test('IMG-08 invalid file type (svg) is rejected and the stray upload is cleaned up', async () => {
    cloudinary.addResource('parisutra-test/laces/vector', { format: 'svg', tags: ['cat_laces'] });
    cloudinary.reset();
    const res = await register('parisutra-test/laces/vector');
    expectStatus(assert, res, 400);
    assert.deepEqual(cloudinary.destroyed(), ['parisutra-test/laces/vector']);
  });

  test('IMG-09 oversized file (> 5 MB) is rejected and cleaned up', async () => {
    cloudinary.addResource('parisutra-test/laces/huge', { bytes: 6 * 1024 * 1024, tags: ['cat_laces'] });
    cloudinary.reset();
    expectStatus(assert, await register('parisutra-test/laces/huge'), 400);
    assert.deepEqual(cloudinary.destroyed(), ['parisutra-test/laces/huge']);
  });

  test('IMG-10 an upload tagged for another category is rejected', async () => {
    cloudinary.addResource('parisutra-test/laces/wrong-tag', { tags: ['cat_trims'] });
    expectStatus(assert, await register('parisutra-test/laces/wrong-tag'), 400);
  });

  test('IMG-11 customers cannot register or delete images', async () => {
    const res = await ctx.request('POST', '/uploads/assets', { token: fx.tokens.customer, body: { publicId: 'x', categoryId: String(fx.laces._id) } });
    expectStatus(assert, res, 403);
  });

  test('IMG-12 only the mocked endpoints were called (no unexpected Cloudinary traffic)', () => {
    assert.deepEqual(cloudinary.calls.filter((c) => c.type === 'unexpected'), []);
  });
});
