// End-to-end tests for admin Category Management (Milestone 4) in real headless Chrome.
// Real UI + real API + isolated MongoDB. Cloudinary is mocked on both sides (see admin-products.e2e.test.js).
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
const PNG = path.join(os.tmpdir(), `parisutra-e2e-cat-${process.pid}.png`);
writeFileSync(PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

const vitePort = await freePort();
const chromeMissing = findChrome() ? false : 'Chrome/Chromium not found (set CHROME_BIN to run browser tests).';
const cloudinary = chromeMissing ? null : await startCloudinaryMock();
const ctx = chromeMissing
  ? { skipReason: chromeMissing, close: async () => {} }
  : await createTestContext(import.meta.url, { extraEnv: { ...cloudinary.env, CORS_ORIGINS: `http://127.0.0.1:${vitePort}` } });

let browser; let vite; let page; let fx; let origin;
let uploadCount = 0;
let uploadSlug = 'laces'; // folder/tag the mocked browser upload is stored under

after(async () => {
  await page?.close();
  await browser?.close();
  await vite?.close();
  await ctx.close();
  await cloudinary?.close();
  rmSync(PNG, { force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(50);
  }
  return fn();
}
const text = () => page.evaluate('document.body.innerText');
const q = (selector) => JSON.stringify(selector);
const rowNames = () => page.evaluate("[...document.querySelectorAll('[data-testid=\"category-row\"] [data-testid=\"category-name\"]')].map((e) => e.textContent.trim())");
const rowFor = (name) => `[...document.querySelectorAll('[data-testid="category-row"]')].find((r) => r.querySelector('[data-testid="category-name"]').textContent.trim() === ${JSON.stringify(name)})`;

async function open(route) {
  await page.goto(`${origin}${route}`);
}

/** Sets a React-controlled input/select/textarea the way typing or selecting would. */
async function fill(selector, value) {
  const present = await page.waitFor(`!!document.querySelector(${q(selector)})`);
  assert.ok(present, `field ${selector} never appeared`);
  await page.evaluate(`(() => {
    const el = document.querySelector(${q(selector)});
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(String(value))});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  })()`);
}

async function click(selector) {
  const ok = await page.waitFor(`(() => { const el = document.querySelector(${q(selector)}); if (!el || el.disabled) return false; el.click(); return true; })()`);
  assert.ok(ok, `could not click ${selector}`);
}

async function clickInRow(name, testid) {
  const ok = await page.waitFor(`(() => { const r = ${rowFor(name)}; const b = r?.querySelector('[data-testid="${testid}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`);
  assert.ok(ok, `could not click ${testid} for ${name}`);
}

async function waitForNames(expected, note) {
  const ok = await page.waitFor(`JSON.stringify([...document.querySelectorAll('[data-testid="category-row"] [data-testid="category-name"]')].map((e) => e.textContent.trim())) === ${q(JSON.stringify(expected))}`);
  assert.ok(ok, `${note}: expected ${JSON.stringify(expected)}, saw ${JSON.stringify(await rowNames())}`);
}

const toastText = () => page.waitFor("document.querySelector('[data-testid=\"toast\"]')?.textContent || ''");
const rowStatus = (name) => page.evaluate(`${rowFor(name)}?.querySelector('[data-testid="category-status"]').textContent`);
const dialogText = () => page.waitFor("document.querySelector('[data-testid=\"confirm-dialog\"]')?.innerText || ''");

describe('Admin category management in the browser', { skip: ctx.skipReason }, () => {
  before(async () => {
    fx = await ctx.seed();
    await ctx.models.Product.create({ title: 'Second Lace Item', slug: 'second-lace-item', category: fx.laces._id, price: 70, stock: 5 });
    await ctx.models.Category.create({ name: 'Archive', slug: 'archive', sortOrder: 3, isActive: false });
    vite = await startViteDevServer({ clientDir: CLIENT_DIR, port: vitePort, apiBase: ctx.base });
    origin = vite.origin;
    browser = await launchBrowser();
    page = await browser.newPage();
    page.mock('POST', /^https:\/\/api\.cloudinary\.com\/v1_1\/[^/]+\/image\/upload$/, () => {
      uploadCount += 1;
      const r = cloudinary.addResource(`parisutra-test/${uploadSlug}/cat-e2e-${uploadCount}`, { tags: [`cat_${uploadSlug.replace(/-/g, '_')}`] });
      return { status: 200, body: { public_id: r.public_id, secure_url: r.secure_url, format: r.format, bytes: r.bytes } };
    });
    await page.goto(`${origin}/favicon.svg`);
    await page.evaluate(`localStorage.setItem('arc_token', ${JSON.stringify(fx.tokens.admin)})`);
  });

  test('CE-01 the list shows real database categories with product counts (no sample data)', async () => {
    await open('/admin/products/categories');
    await waitForNames(['Laces', 'Trims', 'Archive'], 'initial list');
    assert.equal(await page.evaluate(`${rowFor('Laces')}.querySelector('[data-testid="category-products"]').textContent.trim()`), '2');
    assert.equal(await rowStatus('Archive'), 'Inactive');
    assert.match(await page.evaluate("document.querySelector('[data-testid=\"kpi-Total Categories\"]').textContent"), /3$/);
    assert.match(await page.evaluate("document.querySelector('[data-testid=\"kpi-Inactive Categories\"]').textContent"), /1$/);
    assert.match(await page.evaluate("document.querySelector('[data-testid=\"kpi-Products in Categories\"]').textContent"), /3$/);
    const body = await text();
    assert.ok(!/Pom Pom Trims|Designer Collections|286/.test(body), 'hardcoded sample categories must be gone');
  });

  test('CE-02 search and status filter update the URL, survive a refresh and show an empty state', async () => {
    await fill('input[aria-label="Search categories"]', 'tri');
    await waitForNames(['Trims'], 'search');
    assert.match(await page.evaluate('location.search'), /q=tri/);
    await page.reload();
    await waitForNames(['Trims'], 'search after refresh');
    await fill('input[aria-label="Search categories"]', 'nothing-matches');
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"empty-state\"]')"), 'empty state shown');
    await open('/admin/products/categories?status=inactive');
    await waitForNames(['Archive'], 'inactive filter from URL');
  });

  test('CE-03 create a category with an uploaded image; it persists after a refresh', async () => {
    await open('/admin/products/categories');
    await waitForNames(['Laces', 'Trims', 'Archive'], 'reset');
    await fill('#category-name', 'Silk Tassels');
    assert.equal(await page.evaluate("document.querySelector('#category-slug').value"), 'silk-tassels', 'slug generated from name');
    await fill('#category-description', 'Hand-finished silk tassels');
    uploadSlug = 'silk-tassels';
    await page.setFiles('[data-testid="category-image-input"]', [PNG]);
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"category-image-preview\"]')"), 'preview shown');
    await click('[data-testid="save-category"]');
    assert.match(await toastText(), /Silk Tassels” created\.$/);
    await waitForNames(['Laces', 'Trims', 'Archive', 'Silk Tassels'], 'after create');

    const stored = await ctx.models.Category.findOne({ slug: 'silk-tassels' }).lean();
    assert.equal(stored.description, 'Hand-finished silk tassels');
    assert.match(stored.image, /^https:\/\/res\.cloudinary\.com\/parisutra-test-fake-cloud\/image\/upload\/v1\/parisutra-test\/silk-tassels\//);
    await page.reload();
    await waitForNames(['Laces', 'Trims', 'Archive', 'Silk Tassels'], 'after refresh');
    assert.equal(await page.evaluate(`${rowFor('Silk Tassels')}.querySelector('img')?.getAttribute('src')`), stored.image);
  });

  test('CE-04 client validation and server duplicate errors are shown on the field', async () => {
    await click('[data-testid="save-category"]');
    assert.match(await page.waitFor("document.querySelector('[data-testid=\"error-name\"]')?.textContent"), /Enter a category name/);
    await fill('#category-name', 'laces');
    await fill('#category-slug', 'laces-two');
    await click('[data-testid="save-category"]');
    assert.match(await page.waitFor("document.querySelector('[data-testid=\"error-name\"]')?.textContent"), /already exists/);
    assert.equal(await ctx.models.Category.countDocuments({ slug: 'laces-two' }), 0);
  });

  test('CE-05 edit is a URL, survives a refresh, and a slug change keeps the old address', async () => {
    await open('/admin/products/categories');
    await waitForNames(['Laces', 'Trims', 'Archive', 'Silk Tassels'], 'reset');
    await clickInRow('Trims', 'category-name');
    assert.ok(await page.waitFor("location.search.includes('edit=')"), 'edit id in URL');
    assert.ok(await page.waitFor("document.querySelector('#category-name')?.value === 'Trims'"), 'form loaded');
    await page.reload();
    assert.ok(await page.waitFor("document.querySelector('#category-name')?.value === 'Trims'"), 'edit form restored after refresh');
    assert.match(await page.evaluate("document.querySelector('[data-testid=\"edit-usage\"]').textContent"), /Used by 1 product/);

    await fill('#category-name', 'Trims & Edges');
    await fill('#category-slug', 'trims-edges');
    assert.match(await text(), /old address \/trims will keep working/);
    await click('[data-testid="save-category"]');
    assert.match(await toastText(), /old address \/trims still opens/);
    await waitForNames(['Laces', 'Trims & Edges', 'Archive', 'Silk Tassels'], 'after rename');

    const stored = await ctx.models.Category.findById(fx.trims._id).lean();
    assert.equal(stored.slug, 'trims-edges');
    assert.equal(String((await ctx.models.Product.findById(fx.trim._id)).category), String(fx.trims._id), 'product still assigned');
    await page.reload();
    await waitForNames(['Laces', 'Trims & Edges', 'Archive', 'Silk Tassels'], 'rename persisted');
    const old = await ctx.request('GET', '/categories/trims');
    assert.equal(old.status, 200);
    assert.equal(old.body.category.name, 'Trims & Edges');
  });

  test('CE-06 deactivate shows the affected product count, can be cancelled, and never changes products', async () => {
    const before = await ctx.models.Product.find({ category: fx.laces._id }).lean();
    await clickInRow('Laces', 'deactivate');
    const message = await dialogText();
    assert.match(message, /2 products/);
    assert.match(message, /will not be changed or hidden/);
    await click('[data-testid="confirm-dialog"] button:not([data-testid])'); // Cancel
    assert.ok(await page.waitFor("!document.querySelector('[data-testid=\"confirm-dialog\"]')"));
    assert.equal(await rowStatus('Laces'), 'Active');
    assert.equal((await ctx.models.Category.findById(fx.laces._id)).isActive, true);

    await clickInRow('Laces', 'deactivate');
    await dialogText();
    await click('[data-testid="confirm-action"]');
    assert.ok(await page.waitFor(`${rowFor('Laces')}?.querySelector('[data-testid="category-status"]').textContent === 'Inactive'`));
    assert.equal((await ctx.models.Category.findById(fx.laces._id)).isActive, false);
    const after = await ctx.models.Product.find({ category: fx.laces._id }).lean();
    assert.deepEqual(after.map((p) => [String(p._id), p.isActive, String(p.updatedAt)]), before.map((p) => [String(p._id), p.isActive, String(p.updatedAt)]));

    await page.reload();
    assert.ok(await page.waitFor(`${rowFor('Laces')}?.querySelector('[data-testid="category-status"]').textContent === 'Inactive'`), 'persists after refresh');
  });

  test('CE-07 inactive categories are not offered for new products; existing products keep theirs', async () => {
    await open('/admin/products/new');
    assert.ok(await page.waitFor("document.querySelectorAll('select[name=\"category\"] option').length > 1"));
    const options = await page.evaluate("[...document.querySelectorAll('select[name=\"category\"] option')].map((o) => o.textContent)");
    assert.ok(!options.some((o) => /^Laces|Archive/.test(o)), `inactive categories offered: ${options}`);
    assert.ok(options.includes('Trims & Edges') && options.includes('Silk Tassels'), `renamed/new categories listed: ${options}`);

    await open(`/admin/products/${fx.lace._id}/edit`);
    assert.ok(await page.waitFor("document.querySelector('select[name=\"category\"]')?.value === " + JSON.stringify(String(fx.laces._id))), 'saved inactive category still selected');
    const editOptions = await page.evaluate("[...document.querySelectorAll('select[name=\"category\"] option')].map((o) => o.textContent)");
    assert.ok(editOptions.includes('Laces (inactive)'), `current category shown as inactive: ${editOptions}`);
  });

  test('CE-08 storefront: deactivated category hides its products; renamed category serves old and new URLs', async () => {
    await open('/category/laces');
    await sleep(800);
    assert.ok(!(await text()).includes('Test Gold Lace'), 'inactive category page lists no products');
    for (const slug of ['trims-edges', 'trims']) {
      await open(`/category/${slug}`);
      assert.ok(await page.waitFor("document.body.innerText.includes('Test Silver Trim')"), `product listed at /category/${slug}`);
    }
  });

  test('CE-09 restore re-activates a category and the storefront shows it again', async () => {
    await open('/admin/products/categories');
    await clickInRow('Laces', 'activate');
    assert.ok(await page.waitFor(`${rowFor('Laces')}?.querySelector('[data-testid="category-status"]').textContent === 'Active'`));
    assert.match(await toastText(), /active and visible/);
    await open('/category/laces');
    assert.ok(await page.waitFor("document.body.innerText.includes('Test Gold Lace')"), 'products visible again');
  });

  test('CE-10 delete: a category in use explains why and offers deactivation; an empty one is deleted', async () => {
    await open('/admin/products/categories');
    await clickInRow('Laces', 'delete');
    const blocked = await dialogText();
    assert.match(blocked, /can.t be deleted/);
    assert.match(blocked, /2 products \(2 active\)/);
    assert.ok(await page.evaluate("!!document.querySelector('[data-testid=\"deactivate-instead\"]')"));
    assert.ok(!(await page.evaluate("!!document.querySelector('[data-testid=\"confirm-action\"]')")), 'no delete button offered');
    await click('[data-testid="confirm-dialog"] button:not([data-testid])'); // Close

    await clickInRow('Archive', 'delete');
    assert.match(await dialogText(), /permanently deleted/);
    await click('[data-testid="confirm-action"]');
    await waitForNames(['Laces', 'Trims & Edges', 'Silk Tassels'], 'after delete');
    assert.equal(await ctx.models.Category.exists({ slug: 'archive' }), null);
    assert.equal(await ctx.models.Category.exists({ _id: fx.laces._id }) !== null, true);
  });

  test('CE-11 replacing an image in edit mode and cancelling removes the unsaved upload', async () => {
    const stored = await ctx.models.Category.findOne({ slug: 'silk-tassels' }).lean();
    cloudinary.reset();
    await clickInRow('Silk Tassels', 'category-name');
    assert.ok(await page.waitFor("document.querySelector('#category-name')?.value === 'Silk Tassels'"));
    uploadSlug = 'silk-tassels';
    const before = uploadCount;
    await page.setFiles('[data-testid="category-image-input"]', [PNG]);
    assert.ok(await page.waitFor(`document.querySelector('[data-testid="category-image-preview"]')?.src.includes('cat-e2e-${before + 1}')`), 'new image previewed');
    await click('[data-testid="category-form"] button:not([type="submit"])'); // Cancel
    assert.ok(await waitUntil(() => cloudinary.destroyed().includes(`parisutra-test/silk-tassels/cat-e2e-${before + 1}`)), 'unsaved upload destroyed');
    assert.ok(!cloudinary.destroyed().some((id) => stored.image.includes(id)), 'saved image untouched');
    assert.equal((await ctx.models.Category.findById(stored._id).lean()).image, stored.image);
  });

  test('CE-12 no uncaught browser errors; nothing left the machine except locally mocked uploads', () => {
    assert.deepEqual(page.exceptions, []);
    assert.ok(page.mocked.length >= 2 && page.mocked.every((u) => u.startsWith('POST https://api.cloudinary.com/')), 'uploads were answered locally');
    const external = page.blocked.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u) && !/^https:\/\/res\.cloudinary\.com\/parisutra-test-fake-cloud\//.test(u));
    assert.deepEqual(external, []);
  });
});
