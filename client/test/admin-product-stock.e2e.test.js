// Product edit form and concurrent stock changes (Phase 5G.3) in real headless Chrome.
// The form is opened, then stock changes in the database (sale, another admin), then the admin saves.
// Every PUT the page sends is recorded inside the page so the request shape can be checked.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestContext, freePort } from '../../server/test/helpers/harness.js';
import { launchBrowser, startViteDevServer, findChrome } from './helpers/browser.js';

const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vitePort = await freePort();
const chromeMissing = findChrome() ? false : 'Chrome/Chromium not found (set CHROME_BIN to run browser tests).';
const ctx = chromeMissing
  ? { skipReason: chromeMissing, close: async () => {} }
  : await createTestContext(import.meta.url, { extraEnv: { CORS_ORIGINS: `http://127.0.0.1:${vitePort}` } });

let browser; let vite; let page; let fx; let origin; let id;
after(async () => {
  await page?.close();
  await browser?.close();
  await vite?.close();
  await ctx.close();
});

const q = (s) => JSON.stringify(s);
const P = () => ctx.models.Product;
const stock = async () => (await P().findById(id).lean()).stock;
const reset = (n, extra = {}) => P().updateOne({ _id: id }, { $set: { stock: n, title: 'Test Gold Lace', price: 500, ...extra } });

async function fill(name, value) {
  assert.ok(await page.waitFor(`!!document.querySelector('[name="${name}"]')`), `field ${name}`);
  await page.evaluate(`(() => {
    const el = document.querySelector('[name="${name}"]');
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(String(value))});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
}
const value = (name) => page.evaluate(`document.querySelector('[name="${name}"]').value`);
const puts = () => page.evaluate('window.__puts || []');
const save = () => page.evaluate("document.querySelector('[data-testid=\"save-product\"]').click()");

/** Opens the edit form and starts recording the PUT bodies the page sends. */
async function openEdit(expectedStockText) {
  await page.goto(`${origin}/admin/products/${id}/edit`);
  assert.ok(await page.waitFor(`document.querySelector('[name="stock"]')?.value === ${q(expectedStockText)}`), `form shows stock ${expectedStockText}`);
  await page.evaluate(`(() => {
    window.__puts = [];
    const original = window.fetch;
    window.fetch = (url, opts = {}) => {
      if (opts.method === 'PUT' && String(url).includes('/products/')) window.__puts.push(JSON.parse(opts.body));
      return original(url, opts);
    };
  })()`);
}
const savedAndLeft = () => page.waitFor("location.pathname === '/admin/products'");

describe('Product edit form and concurrent stock changes', { skip: ctx.skipReason }, () => {
  before(async () => {
    fx = await ctx.seed();
    id = String(fx.lace._id);
    vite = await startViteDevServer({ clientDir: CLIENT_DIR, port: vitePort, apiBase: ctx.base });
    origin = vite.origin;
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.goto(`${origin}/favicon.svg`);
    await page.evaluate(`localStorage.setItem('arc_token', ${q(fx.tokens.admin)})`);
  });

  test('PSE-01 open at 10, a customer buys 2, the admin saves a title change: stock stays 8 and is not sent', async () => {
    await reset(10);
    await openEdit('10');
    assert.equal((await ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 2 }])).status, 201);
    await fill('title', 'Gold Lace (edited)');
    await save();
    assert.ok(await savedAndLeft(), 'saved');
    const [body] = await puts();
    assert.equal(body.title, 'Gold Lace (edited)');
    assert.equal('stock' in body, false, 'stock not sent');
    assert.equal('expectedStock' in body, false, 'expectedStock not sent');
    assert.equal(await stock(), 8);
  });

  test('PSE-02 open at 10, another admin adds 5, the admin saves a price change: stock stays 15', async () => {
    await reset(10);
    await openEdit('10');
    const add = await ctx.request('POST', `/products/${id}/stock/adjust`, { token: fx.tokens.admin, body: { operation: 'add', quantity: 5, reason: 'Delivery' } });
    assert.equal(add.status, 200);
    await fill('price', '540');
    await save();
    assert.ok(await savedAndLeft());
    assert.equal(await stock(), 15);
    assert.equal((await P().findById(id).lean()).price, 540);
  });

  test('PSE-03 typing a value and changing it back counts as untouched', async () => {
    await reset(10);
    await openEdit('10');
    await fill('stock', '12');
    await fill('stock', '10');
    await fill('metaTitle', 'SEO only');
    await save();
    assert.ok(await savedAndLeft());
    assert.equal('stock' in (await puts())[0], false);
  });

  test('PSE-04 an intentional change sends the new stock and the opened-with value', async () => {
    await reset(10);
    await openEdit('10');
    await fill('stock', '15');
    await save();
    assert.ok(await savedAndLeft());
    const [body] = await puts();
    assert.deepEqual([body.stock, body.expectedStock], [15, 10]);
    assert.equal(await stock(), 15);
  });

  test('PSE-05 stock changed while the form was open: conflict shown, nothing saved, no automatic retry', async () => {
    await reset(10);
    await openEdit('10');
    assert.equal((await ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 2 }])).status, 201);
    await fill('title', 'Should not save yet');
    await fill('stock', '15');
    await save();
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"stock-conflict\"]')"), 'conflict message');
    const panel = await page.evaluate("document.querySelector('[data-testid=\"stock-conflict\"]').innerText");
    assert.match(panel, /Stock changed while this form was open/);
    assert.equal(await page.evaluate("document.querySelector('[data-testid=\"stock-conflict-opened\"]').textContent"), '10');
    assert.equal(await page.evaluate("document.querySelector('[data-testid=\"stock-conflict-current\"]').textContent"), '8');
    assert.equal(await page.evaluate('location.pathname'), `/admin/products/${id}/edit`, 'stays on the form');
    assert.equal(await value('title'), 'Should not save yet', 'other edits kept in the form');
    assert.equal(await value('stock'), '15');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await puts()).length, 1, 'no silent resubmit');
    const dbAfter = await P().findById(id).lean();
    assert.deepEqual([dbAfter.stock, dbAfter.title], [8, 'Test Gold Lace'], 'nothing saved');

    // Saving again without reviewing is refused again (the guard is still the opened-with value).
    await save();
    assert.ok(await page.waitFor('(window.__puts || []).length === 2'));
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"stock-conflict\"]')"));
    assert.equal(await stock(), 8);

    // The admin reviews explicitly: starts from the current 8 and enters the intended value.
    await page.evaluate("document.querySelector('[data-testid=\"stock-conflict-review\"]').click()");
    assert.ok(await page.waitFor("!document.querySelector('[data-testid=\"stock-conflict\"]') && document.querySelector('[name=\"stock\"]').value === '8'"));
    await fill('stock', '20');
    await save();
    assert.ok(await savedAndLeft(), 'saved after review');
    const last = (await puts()).at(-1);
    assert.deepEqual([last.stock, last.expectedStock], [20, 8]);
    const final = await P().findById(id).lean();
    assert.deepEqual([final.stock, final.title], [20, 'Should not save yet']);
  });

  test('PSE-06 legacy product without a stock value: shown as 0; unrelated edits do not create one', async () => {
    await P().updateOne({ _id: id }, { $unset: { stock: '' } });
    await openEdit('0');
    await fill('description', 'Legacy edit');
    await save();
    assert.ok(await savedAndLeft());
    assert.equal('stock' in (await puts())[0], false);
    assert.equal('stock' in (await P().findById(id).lean()), false);
    await openEdit('0');
    await fill('stock', '6');
    await save();
    assert.ok(await savedAndLeft());
    assert.deepEqual([(await puts())[0].stock, (await puts())[0].expectedStock], [6, 0]);
    assert.equal(await stock(), 6);
  });

  test('PSE-07 a legacy fractional stock does not block unrelated edits', async () => {
    await reset(2.5);
    await openEdit('2.5');
    await fill('title', 'Fractional Legacy');
    await save();
    assert.ok(await savedAndLeft(), 'unchanged stock is not validated or sent');
    assert.equal(await stock(), 2.5);
    await openEdit('2.5');
    await fill('stock', '3.5');
    await save();
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"error-stock\"]')"), 'a changed stock must be a whole number');
    assert.equal((await puts()).length, 0);
  });

  test('PSE-08 creating a product still saves its initial stock', async () => {
    await page.goto(`${origin}/admin/products/new`);
    assert.ok(await page.waitFor("document.querySelectorAll('[name=\"category\"] option').length > 2"));
    await fill('title', 'Fresh Stocked Trim');
    await page.evaluate(`(() => { const el = document.querySelector('[name="category"]'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, ${q(String(fx.trims._id))}); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await fill('price', '75');
    await fill('stock', '33');
    await page.evaluate("document.querySelector('[data-testid=\"save-product\"]').click()");
    assert.ok(await savedAndLeft());
    assert.equal((await P().findOne({ title: 'Fresh Stocked Trim' }).lean()).stock, 33);
  });

  test('PSE-09 no uncaught errors; nothing left the machine', () => {
    assert.deepEqual(page.exceptions, []);
    assert.deepEqual(page.blocked.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)), []);
  });
});
