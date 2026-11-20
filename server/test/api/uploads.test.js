// Cloudinary upload APIs (CLD-01…07). Uses FAKE Cloudinary credentials and only exercises code paths
// that run before any network call (config, local signature generation, folder/publicId validation,
// listing, 404s). No request is ever sent to api.cloudinary.com.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus, FAKE_CLOUDINARY } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url, { extraEnv: FAKE_CLOUDINARY });
after(() => ctx.close());

describe('Cloudinary upload APIs (pre-network paths only)', { skip: ctx.skipReason }, () => {
  let fx;
  const admin = (method, path, body) => ctx.request(method, path, { token: fx.tokens.admin, body });
  before(async () => { fx = await ctx.seed(); });

  test('CLD-01 /uploads/config exposes public settings but never the API secret', async () => {
    const res = await admin('GET', '/uploads/config');
    expectStatus(assert, res, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.cloudName, FAKE_CLOUDINARY.CLOUDINARY_CLOUD_NAME);
    assert.equal(res.body.maxBytes, 5 * 1024 * 1024);
    assert.ok(!res.body.formats.includes('svg'));
    assert.ok(!JSON.stringify(res.body).includes(FAKE_CLOUDINARY.CLOUDINARY_API_SECRET));
  });

  test('CLD-02 signing requires a valid active category', async () => {
    expectStatus(assert, await admin('POST', '/uploads/sign', {}), 400);
    expectStatus(assert, await admin('POST', '/uploads/sign', { categoryId: 'abc' }), 400);
    expectStatus(assert, await admin('POST', '/uploads/sign', { categoryId: String(new ctx.mongoose.Types.ObjectId()) }), 400);
  });

  test('CLD-03 signature uses a server-derived folder/tag (client folder ignored) and never leaks the secret', async () => {
    const res = await admin('POST', '/uploads/sign', { categoryId: String(fx.trims._id), folder: 'evil/root', tags: 'x' });
    expectStatus(assert, res, 200);
    assert.equal(res.body.folder, 'parisutra-test/trims');
    assert.equal(res.body.tags, 'cat_trims');
    assert.match(res.body.signature, /^[a-f0-9]{40}$/);
    assert.ok(!JSON.stringify(res.body).includes(FAKE_CLOUDINARY.CLOUDINARY_API_SECRET));
  });

  test('CLD-04 registering an asset outside the category folder → 400 (before any Cloudinary call)', async () => {
    const res = await admin('POST', '/uploads/assets', { categoryId: String(fx.trims._id), publicId: 'other/folder/x' });
    expectStatus(assert, res, 400);
    const sibling = await admin('POST', '/uploads/assets', { categoryId: String(fx.trims._id), publicId: 'parisutra-test/trims-extra/x' });
    expectStatus(assert, sibling, 400);
  });

  test('CLD-05 path traversal in publicId → 400', async () => {
    const res = await admin('POST', '/uploads/assets', { categoryId: String(fx.trims._id), publicId: 'parisutra-test/trims/../laces/x' });
    expectStatus(assert, res, 400);
  });

  test('CLD-06 deleting a malformed or unknown asset id → 404', async () => {
    expectStatus(assert, await admin('DELETE', '/uploads/assets/abc'), 404);
    expectStatus(assert, await admin('DELETE', `/uploads/assets/${new ctx.mongoose.Types.ObjectId()}`), 404);
  });

  test('CLD-07 asset listing is paginated and filterable by category', async () => {
    const res = await admin('GET', '/uploads/assets?page=1&limit=5');
    expectStatus(assert, res, 200);
    assert.equal(res.body.limit, 5);
    assert.deepEqual(res.body.assets, []);
    expectStatus(assert, await admin('GET', '/uploads/assets?category=laces'), 200);
    expectStatus(assert, await admin('GET', '/uploads/assets?category=nope'), 404);
  });
});
// Behaviour with missing Cloudinary credentials is asserted in cms.test.js (CLD-08), which runs in a
// separate process without CLOUDINARY_* variables.
