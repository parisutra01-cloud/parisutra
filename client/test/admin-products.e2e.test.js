// End-to-end tests for admin Product Management (Milestone 3) in real headless Chrome.
// Real UI + real API + isolated MongoDB. Cloudinary is mocked on both sides:
//   - the browser's direct upload is answered inside Chrome (helpers/browser.js page.mock),
//   - the API's verification/deletion calls go to a local mock server (server/test/helpers/cloudinaryMock.js).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestContext, freePort } from '../../server/test/helpers/harness.js';
import { startCloudinaryMock } from '../../server/test/helpers/cloudinaryMock.js';
import { launchBrowser, startViteDevServer, findChrome } from './helpers/browser.js';

const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PNG = path.join(os.tmpdir(), `parisutra-e2e-${process.pid}.png`);
writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

const vitePort = await freePort();
const chromeMissing = findChrome() ? false : 'Chrome/Chromium not found (set CHROME_BIN to run browser tests).';
const cloudinary = chromeMissing ? null : await startCloudinaryMock();
const ctx = chromeMissing
  ? { skipReason: chromeMissing, close: async () => {} }
  : await createTestContext(import.meta.url, { extraEnv: { ...cloudinary.env, CORS_ORIGINS: `http://127.0.0.1:${vitePort}` } });

let browser; let vite; let page; let fx; let origin;
let uploadCount = 0;
let uploadFails = false;

after(async () => {
  await page?.close();
  await browser?.close();
  await vite?.close();
  await ctx.close();
  await cloudinary?.close();
  rmSync(PNG, { force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Polls a Node-side condition (e.g. calls recorded by the Cloudinary mock). */
async function waitUntil(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return fn();
}
const text = () => page.evaluate('document.body.innerText');
const rowTitles = () => page.evaluate("[...document.querySelectorAll('[data-testid=\"product-row\"] [data-testid=\"product-title\"]')].map((e) => e.textContent.trim())");

async function open(route) {
  await page.goto(`${origin}${route}`);
}

/** Sets a React-controlled field by name the way typing/selecting would. */
async function fill(name, value) {
  const present = await page.waitFor(`!!document.querySelector('[name="${name}"]')`);
  assert.ok(present, `field ${name} never appeared`);
  await page.evaluate(`(() => {
    const el = document.querySelector('[name="${name}"]');
    if (!el) throw new Error('no field ${name}');
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  })()`);
}

async function click(selector) {
  const ok = await page.waitFor(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el || el.disabled) return false; el.click(); return true; })()`);
  assert.ok(ok, `could not click ${selector}`);
}

async function waitForRows(n, note) {
  const ok = await page.waitFor(`document.querySelectorAll('[data-testid="product-row"]').length === ${n} && !document.querySelector('[aria-busy="true"]')`);
  assert.ok(ok, `${note}: expected ${n} rows, saw ${JSON.stringify(await rowTitles())}`);
}

describe('Admin product management in the browser', { skip: ctx.skipReason }, () => {
  before(async () => {
    fx = await ctx.seed();
    for (let i = 1; i <= 12; i += 1) {
      await ctx.models.Product.create({ title: `Catalogue Item ${String(i).padStart(2, '0')}`, slug: `catalogue-item-${i}`, category: fx.trims._id, price: 50 + i, stock: 100 });
    }
    vite = await startViteDevServer({ clientDir: CLIENT_DIR, port: vitePort, apiBase: ctx.base });
    origin = vite.origin;
    browser = await launchBrowser();
    page = await browser.newPage();
    page.mock('POST', /^https:\/\/api\.cloudinary\.com\/v1_1\/[^/]+\/image\/upload$/, () => {
      if (uploadFails) return { status: 400, body: { error: { message: 'Invalid image file' } } };
      uploadCount += 1;
      const r = cloudinary.addResource(`parisutra-test/laces/e2e-${uploadCount}`, { tags: ['cat_laces'] });
      return { status: 200, body: { public_id: r.public_id, secure_url: r.secure_url, format: r.format, bytes: r.bytes } };
    });
    await page.goto(`${origin}/favicon.svg`);
    await page.evaluate(`localStorage.setItem('arc_token', ${JSON.stringify(fx.tokens.admin)})`);
  });

  test('PE-01 the list shows real database products and live KPI counts (no sample data)', async () => {
    await open('/admin/products');
    await waitForRows(10, 'first page');
    assert.match(await page.evaluate("document.querySelector('[data-testid=\"pagination-summary\"]').textContent"), /Showing 1 – 10 of 14 products/);
    assert.equal(await page.evaluate("document.querySelector('[data-testid=\"kpi-Total Products\"]').textContent"), '14');
    const body = await text();
    assert.ok(!/Red Bridal Latkan|Golden Zari Lace Trim/.test(body), 'hardcoded sample products must be gone');
  });

  test('PE-02 pagination is server-side and survives a refresh', async () => {
    await click('button[aria-label="Next page"]');
    await waitForRows(4, 'page 2');
    assert.match(await page.evaluate('location.search'), /page=2/);
    await page.reload();
    await waitForRows(4, 'page 2 after refresh');
    assert.match(await page.evaluate("document.querySelector('[data-testid=\"pagination-summary\"]').textContent"), /11 – 14 of 14/);
  });

  test('PE-03 search and filters query the API, update the URL and survive a refresh', async () => {
    await open('/admin/products');
    await waitForRows(10, 'reset');
    await fill('q', 'Silver');
    assert.ok(await page.waitFor("location.search.includes('q=Silver')"), 'search should be reflected in the URL');
    await waitForRows(1, 'search Silver');
    assert.deepEqual(await rowTitles(), ['Test Silver Trim']);
    await page.reload();
    await waitForRows(1, 'search after refresh');
    assert.equal(await page.evaluate("document.querySelector('[name=\"q\"]').value"), 'Silver');
    await fill('status', 'inactive');
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"empty-state\"]')"), 'empty state for no matches');
    await open(`/admin/products?category=${fx.laces._id}`);
    await waitForRows(1, 'category filter');
    assert.deepEqual(await rowTitles(), ['Test Gold Lace']);
  });

  test('PE-04 create a product with an uploaded image; it persists and appears in the store', async () => {
    await open('/admin/products/new');
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"product-form\"]') && document.querySelectorAll('[name=\"category\"] option').length > 2"));
    await fill('title', 'E2E Royal Lace');
    await fill('category', String(fx.laces._id));
    await fill('unit', 'piece');
    await fill('price', '249');
    await fill('stock', '7');
    await fill('sku', 'E2E-1');
    await page.setFiles('[data-testid="image-input"]', [PNG]);
    assert.ok(await page.waitFor("document.querySelectorAll('[data-testid=\"image-tile\"]').length === 1"), 'uploaded image tile');
    await click('[data-testid="save-product"]');
    assert.ok(await page.waitFor("location.pathname === '/admin/products'"), 'redirect to list after save');
    assert.match(await page.waitFor("document.querySelector('[data-testid=\"toast\"]')?.textContent"), /E2E Royal Lace.*published/);

    const saved = await ctx.models.Product.findOne({ title: 'E2E Royal Lace' }).lean();
    assert.ok(saved, 'product saved in MongoDB');
    assert.equal(saved.price, 249);
    assert.equal(saved.stock, 7);
    assert.equal(saved.unit, 'piece');
    assert.equal(saved.slug, 'e2e-royal-lace');
    assert.equal(saved.isActive, true);
    assert.match(saved.images[0].url, /^https:\/\/res\.cloudinary\.com\/parisutra-test-fake-cloud\/image\/upload\/v1\/parisutra-test\/laces\/e2e-1\.png$/);
    assert.ok(await ctx.mongoose.connection.db.collection('mediaassets').findOne({ publicId: 'parisutra-test/laces/e2e-1' }));

    await page.reload();
    await fill('q', 'E2E Royal');
    await waitForRows(1, 'new product listed after refresh');
    assert.equal((await ctx.request('GET', '/products/slug/e2e-royal-lace')).status, 200, 'visible on the storefront API');
  });

  test('PE-05 validation errors are shown next to the fields (client and server)', async () => {
    await open('/admin/products/new');
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"product-form\"]')"));
    await click('[data-testid="save-product"]');
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"error-title\"]') && !!document.querySelector('[data-testid=\"error-price\"]') && !!document.querySelector('[data-testid=\"error-category\"]')"), 'client-side errors');

    await page.waitFor("document.querySelectorAll('[name=\"category\"] option').length > 2");
    await fill('title', 'Duplicate Sku Attempt');
    await fill('category', String(fx.laces._id));
    await fill('price', '10');
    await fill('sku', 'e2e-1');
    await click('[data-testid="save-product"]');
    assert.equal(await page.waitFor("document.querySelector('[data-testid=\"error-sku\"]')?.textContent"), 'SKU already exists');
    assert.equal(await page.evaluate('location.pathname'), '/admin/products/new', 'stays on the form');
    assert.equal(await ctx.models.Product.countDocuments({ title: 'Duplicate Sku Attempt' }), 0);
  });

  test('PE-06 editing a product persists after a browser refresh', async () => {
    await open('/admin/products?q=Gold');
    await waitForRows(1, 'find Test Gold Lace');
    await click('a[aria-label="Edit Test Gold Lace"]');
    assert.ok(await page.waitFor("document.querySelector('[name=\"title\"]')?.value === 'Test Gold Lace'"), 'form prefilled from the API');
    assert.equal(await page.evaluate("document.querySelector('[name=\"price\"]').value"), '500');
    await fill('price', '555');
    await fill('shortDescription', 'Edited in the browser');
    await click('[data-testid="save-product"]');
    assert.ok(await page.waitFor("location.pathname === '/admin/products'"));
    assert.match(await page.waitFor("document.querySelector('[data-testid=\"toast\"]')?.textContent"), /updated/);
    await open(`/admin/products/${fx.lace._id}/edit`);
    assert.ok(await page.waitFor("document.querySelector('[name=\"price\"]')?.value === '555'"), 'price persisted after reload');
    assert.equal(await page.evaluate("document.querySelector('[name=\"shortDescription\"]').value"), 'Edited in the browser');
    assert.equal((await ctx.models.Product.findById(fx.lace._id)).price, 555);
  });

  test('PE-07 delete asks for confirmation (cancel keeps it), then hides it; restore brings it back', async () => {
    await open('/admin/products?q=Silver');
    await waitForRows(1, 'find Test Silver Trim');
    await click('button[aria-label="Delete Test Silver Trim"]');
    assert.ok(await page.waitFor("!!document.querySelector('[role=\"dialog\"]')"), 'confirmation dialog');
    await page.evaluate("[...document.querySelectorAll('[role=\"dialog\"] button')].find((b) => b.textContent.trim() === 'Cancel').click()");
    assert.ok(await page.waitFor("!document.querySelector('[role=\"dialog\"]')"));
    assert.equal((await ctx.models.Product.findById(fx.trim._id)).isActive, true, 'cancel must not delete');

    await click('button[aria-label="Delete Test Silver Trim"]');
    await click('[data-testid="confirm-delete"]');
    assert.ok(await page.waitFor("document.querySelector('[data-testid=\"product-status\"]')?.textContent === 'Inactive'"));
    assert.equal((await ctx.models.Product.findById(fx.trim._id)).isActive, false);
    assert.equal((await ctx.request('GET', '/products/slug/test-silver-trim')).status, 404, 'gone from the storefront');
    await page.reload();
    assert.ok(await page.waitFor("document.querySelector('[data-testid=\"product-status\"]')?.textContent === 'Inactive'"), 'still inactive after refresh');

    await click('button[aria-label="Restore Test Silver Trim"]');
    assert.ok(await page.waitFor("document.querySelector('[data-testid=\"product-status\"]')?.textContent === 'Active'"));
    assert.equal((await ctx.models.Product.findById(fx.trim._id)).isActive, true);
  });

  test('PE-08 an image upload failure is reported and nothing is registered', async () => {
    const before = await ctx.mongoose.connection.db.collection('mediaassets').countDocuments();
    uploadFails = true;
    try {
      await open('/admin/products/new');
      await page.waitFor("document.querySelectorAll('[name=\"category\"] option').length > 2");
      await fill('category', String(fx.laces._id));
      await page.setFiles('[data-testid="image-input"]', [PNG]);
      assert.match(await page.waitFor("document.querySelector('[data-testid=\"error-images\"]')?.textContent"), /Invalid image file/);
      assert.equal(await page.evaluate("document.querySelectorAll('[data-testid=\"image-tile\"]').length"), 0);
    } finally {
      uploadFails = false;
    }
    assert.equal(await ctx.mongoose.connection.db.collection('mediaassets').countDocuments(), before);
  });

  test('PE-09 unsaved uploads are cleaned up when removed or when the form is cancelled', async () => {
    await open('/admin/products/new');
    await page.waitFor("document.querySelectorAll('[name=\"category\"] option').length > 2");
    await fill('category', String(fx.laces._id));
    await page.setFiles('[data-testid="image-input"]', [PNG]);
    assert.ok(await page.waitFor("document.querySelectorAll('[data-testid=\"image-tile\"]').length === 1"));
    const first = `parisutra-test/laces/e2e-${uploadCount}`;
    await click('button[aria-label="Remove image 1"]');
    assert.ok(await waitUntil(() => cloudinary.destroyed().includes(first)), 'removed upload destroyed in Cloudinary');
    assert.equal(await ctx.mongoose.connection.db.collection('mediaassets').findOne({ publicId: first }), null);

    await page.setFiles('[data-testid="image-input"]', [PNG]);
    assert.ok(await page.waitFor("document.querySelectorAll('[data-testid=\"image-tile\"]').length === 1"));
    const second = `parisutra-test/laces/e2e-${uploadCount}`;
    await page.evaluate("[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Cancel').click()");
    assert.ok(await waitUntil(() => cloudinary.destroyed().includes(second)), 'cancelled form discards its upload');
    assert.ok(cloudinary.destroyed().every((id) => /\/e2e-\d+$/.test(id)), 'only test uploads were ever destroyed');
    assert.ok(await ctx.mongoose.connection.db.collection('mediaassets').findOne({ publicId: 'parisutra-test/laces/e2e-1' }), 'the saved product image is untouched');
  });

  test('PE-10 editing a product that does not exist shows a not-found state', async () => {
    await open(`/admin/products/${new ctx.mongoose.Types.ObjectId()}/edit`);
    assert.ok(await page.waitFor("document.body.innerText.includes('Product not found')"));
  });

  test('PE-11 no uncaught browser errors; nothing left the machine except locally mocked uploads', () => {
    assert.deepEqual(page.exceptions, []);
    assert.ok(page.mocked.length >= 3 && page.mocked.every((u) => u.startsWith('POST https://api.cloudinary.com/')), 'uploads were answered locally');
    const external = page.blocked.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u) && !/^https:\/\/res\.cloudinary\.com\/parisutra-test-fake-cloud\//.test(u));
    assert.deepEqual(external, []);
  });
});
