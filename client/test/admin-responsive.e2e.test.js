// Responsive admin layout (Phase 5F.1) in real headless Chrome: navigation drawer below 1024px,
// compact top bar, no layout-level horizontal overflow, desktop layout unchanged.
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

let browser; let vite; let page; let fx; let origin; let orderId;
after(async () => {
  await page?.close();
  await browser?.close();
  await vite?.close();
  await ctx.close();
});

const WIDTHS = [390, 430, 768, 1024, 1440];
const q = (s) => JSON.stringify(s);
const sel = (id) => `[data-testid="${id}"]`;

async function setWidth(width) {
  await page.cdp('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: width < 1024 });
}

/** Layout facts measured in the page. */
const measure = () => page.evaluate(`(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const aside = document.querySelector('[data-testid="admin-sidebar"]');
  const toggle = document.querySelector('[data-testid="admin-nav-toggle"]');
  const header = document.querySelector('header');
  const controls = {
    toggle: toggle && getComputedStyle(toggle).display !== 'none' ? r(toggle) : null,
    search: r(header.querySelector('input')?.parentElement),
    store: r(header.querySelector('a[aria-label="View Store"]')),
    bell: r(header.querySelector('a[aria-label="Notifications"]')),
    avatar: r([...header.querySelectorAll('div')].find((d) => d.textContent.trim() === 'AS')),
  };
  return {
    vw: window.innerWidth,
    docOverflow: document.documentElement.scrollWidth - window.innerWidth,
    main: r(document.querySelector('main')),
    header: r(header),
    aside: r(aside),
    asideVisible: getComputedStyle(aside).visibility === 'visible',
    asidePosition: getComputedStyle(aside).position,
    asideOpen: aside.dataset.open,
    controls,
    bodyOverflow: document.body.style.overflow,
    backdrop: !!document.querySelector('[data-testid="admin-nav-backdrop"]'),
    focused: document.activeElement?.getAttribute('data-testid') || null,
  };
})()`);

function assertNoOverlap(controls, note) {
  const boxes = Object.entries(controls).filter(([, b]) => b && b.width > 0);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const [na, a] = boxes[i];
      const [nb, b] = boxes[j];
      const overlap = a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
      assert.ok(!overlap, `${note}: ${na} overlaps ${nb}`);
    }
  }
}

async function openPage(route, readyExpr) {
  await page.goto(`${origin}${route}`);
  assert.ok(await page.waitFor(readyExpr, { timeout: 15000 }), `${route} did not render`);
}

describe('Responsive admin layout', { skip: ctx.skipReason }, () => {
  const PAGES = () => [
    ['/admin', "!!document.querySelector('[data-testid=\"dashboard\"]')"],
    ['/admin/products', "document.querySelectorAll('[data-testid=\"product-row\"]').length > 0"],
    ['/admin/products/categories', "document.querySelectorAll('[data-testid=\"category-row\"]').length > 0"],
    ['/admin/orders', "document.querySelectorAll('[data-testid=\"order-row\"]').length > 0"],
    [`/admin/orders/${orderId}`, "!!document.querySelector('[data-testid=\"order-detail\"]')"],
  ];

  before(async () => {
    fx = await ctx.seed();
    await ctx.models.Product.updateOne({ _id: fx.lace._id }, { stock: 20 });
    const placed = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 2 }]);
    orderId = placed.body.order._id;
    vite = await startViteDevServer({ clientDir: CLIENT_DIR, port: vitePort, apiBase: ctx.base });
    origin = vite.origin;
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.goto(`${origin}/favicon.svg`);
    await page.evaluate(`localStorage.setItem('arc_token', ${q(fx.tokens.admin)})`);
  });
  after(async () => { await page?.cdp('Emulation.clearDeviceMetricsOverride', {}).catch(() => {}); });

  for (const width of WIDTHS) {
    test(`RL-${width} at ${width}px: no layout overflow, content width, usable top bar on every checked page`, async () => {
      await setWidth(width);
      for (const [route, ready] of PAGES()) {
        await openPage(route, ready);
        const m = await measure();
        const note = `${route} @${width}px`;
        assert.ok(m.docOverflow <= 0, `${note}: page scrolls horizontally by ${m.docOverflow}px`);
        assert.ok(m.header.right <= m.vw + 0.5, `${note}: top bar wider than the screen`);
        for (const [name, box] of Object.entries(m.controls)) {
          if (!box) continue;
          assert.ok(box.left >= -0.5 && box.right <= m.vw + 0.5, `${note}: ${name} outside the screen (${box.left}–${box.right})`);
          assert.ok(box.width > 0 && box.height > 0, `${note}: ${name} not visible`);
        }
        assertNoOverlap(m.controls, note);
        assert.ok(m.controls.store && m.controls.bell && m.controls.avatar && m.controls.search, `${note}: essential top-bar controls present`);
        if (width < 1024) {
          assert.ok(m.controls.toggle, `${note}: menu button shown`);
          assert.equal(m.asideVisible, false, `${note}: sidebar closed`);
          assert.ok(m.aside.right <= 0.5, `${note}: closed sidebar is off-screen`);
          assert.equal(Math.round(m.main.width), m.vw, `${note}: content uses the full width`);
          if (width < 640) assert.ok(m.controls.search.width >= m.vw - 40, `${note}: search gets its own full-width row`);
        } else {
          assert.equal(m.controls.toggle, null, `${note}: no menu button on desktop`);
          assert.equal(m.asideVisible, true, `${note}: sidebar shown`);
          assert.equal(m.asidePosition, 'static', `${note}: sidebar is a normal column`);
          assert.equal(Math.round(m.aside.width), 248);
          assert.equal(Math.round(m.main.left), 248, `${note}: content starts after the sidebar`);
          assert.equal(Math.round(m.main.width), m.vw - 248);
        }
      }
    });
  }

  test('RL-DRAWER the menu opens and closes (button, backdrop, Escape, navigation) and locks page scrolling', async () => {
    await setWidth(390);
    await openPage('/admin/orders', "document.querySelectorAll('[data-testid=\"order-row\"]').length > 0");
    const toggleExpanded = () => page.evaluate(`document.querySelector(${q(sel('admin-nav-toggle'))}).getAttribute('aria-expanded')`);
    assert.equal(await toggleExpanded(), 'false');

    const open = async () => {
      await page.evaluate(`document.querySelector(${q(sel('admin-nav-toggle'))}).click()`);
      assert.ok(await page.waitFor(`document.querySelector(${q(sel('admin-sidebar'))}).dataset.open === 'true' && getComputedStyle(document.querySelector(${q(sel('admin-sidebar'))})).visibility === 'visible'`));
      await new Promise((r) => setTimeout(r, 250)); // let the slide-in transition finish before measuring
    };
    const isClosed = () => page.waitFor(`document.querySelector(${q(sel('admin-sidebar'))}).dataset.open === 'false' && !document.querySelector(${q(sel('admin-nav-backdrop'))}) && document.body.style.overflow === ''`);

    await open();
    let m = await measure();
    assert.equal(await toggleExpanded(), 'true');
    assert.ok(m.backdrop, 'backdrop shown');
    assert.equal(m.bodyOverflow, 'hidden', 'background scrolling locked');
    assert.equal(m.focused, 'admin-nav-close', 'focus moved into the drawer');
    assert.ok(Math.abs(m.aside.left) < 1 && m.aside.right <= m.vw, 'drawer fully on screen');
    assert.ok(m.docOverflow <= 0);

    await page.evaluate(`document.querySelector(${q(sel('admin-nav-close'))}).click()`);
    assert.ok(await isClosed(), 'close button');

    await open();
    await page.evaluate(`document.querySelector(${q(sel('admin-nav-backdrop'))}).dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    assert.ok(await isClosed(), 'tap outside');

    await open();
    await page.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    assert.ok(await isClosed(), 'Escape key');

    await open();
    await page.evaluate(`[...document.querySelectorAll(${q(`${sel('admin-sidebar')} a`)})].find((a) => a.textContent.trim() === 'Dashboard').click()`);
    assert.ok(await page.waitFor("location.pathname === '/admin'"), 'navigated');
    assert.ok(await isClosed(), 'closed after navigation');
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"dashboard\"]')"));
  });

  test('RL-RESIZE growing to desktop width with the drawer open releases the scroll lock', async () => {
    await setWidth(768);
    await openPage('/admin', "!!document.querySelector('[data-testid=\"dashboard\"]')");
    await page.evaluate(`document.querySelector(${q(sel('admin-nav-toggle'))}).click()`);
    assert.ok(await page.waitFor("document.body.style.overflow === 'hidden'"));
    await setWidth(1280);
    assert.ok(await page.waitFor("document.body.style.overflow === ''"), 'scroll lock released');
    const m = await measure();
    assert.equal(m.asideVisible, true);
    assert.equal(m.backdrop, false);
  });

  test('RL-LINKS direct links, refresh and parallel edits survive on mobile; customers are still redirected', async () => {
    await setWidth(390);
    await openPage(`/admin/orders/${orderId}`, "!!document.querySelector('[data-testid=\"order-detail\"]')");
    await page.reload();
    assert.ok(await page.waitFor("!!document.querySelector('[data-testid=\"order-detail\"]')"), 'detail after refresh');
    // Parallel edits in the layout are still there: the "Top banner" nav label and PARISUTRA branding.
    await setWidth(1280);
    // Wait for the admin shell (the auth check renders "Checking access…" first), then assert.
    await openPage('/admin/content/announcements', `!!document.querySelector(${q(sel('admin-sidebar'))})`);
    assert.ok(await page.waitFor(`[...document.querySelectorAll(${q(`${sel('admin-sidebar')} a`)})].some((a) => a.textContent.trim() === 'Top banner')`), '"Top banner" nav label present');
    assert.ok(await page.waitFor("!!document.querySelector('header')?.innerText.includes('PARISUTRA')"), 'PARISUTRA label present');

    await page.evaluate(`localStorage.setItem('arc_token', ${q(fx.tokens.customer)})`);
    try {
      await setWidth(390);
      await page.goto(`${origin}/admin/orders`);
      assert.ok(await page.waitFor("location.pathname === '/'"), 'customer redirected away from admin');
    } finally {
      await page.evaluate(`localStorage.setItem('arc_token', ${q(fx.tokens.admin)})`);
    }
  });

  test('RL-CLEAN no uncaught errors; nothing left the machine', () => {
    assert.deepEqual(page.exceptions, []);
    assert.deepEqual(page.blocked.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u)), []);
  });
});
