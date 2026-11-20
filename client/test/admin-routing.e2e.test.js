// Browser regression tests for admin routing (Milestone 2 / audit ADM-003).
// Real headless Chrome + Vite dev server + the real API on an isolated MongoDB (server/test harness).
// External network is blocked inside the browser; see helpers/browser.js.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestContext, freePort, PASSWORDS } from '../../server/test/helpers/harness.js';
import { launchBrowser, startViteDevServer, findChrome } from './helpers/browser.js';

const CLIENT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every admin path declared in App.jsx (kept in sync automatically). */
function adminRoutesFromApp() {
  const app = readFileSync(path.join(CLIENT_DIR, 'src', 'App.jsx'), 'utf8');
  const block = app.slice(app.indexOf('<Route path="/admin"'), app.indexOf('</Route>', app.indexOf('<Route path="/admin"')));
  const children = [...block.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]).filter((p) => p !== '/admin');
  const fakeId = '64b7f0c2a1b2c3d4e5f60718';
  return ['/admin', ...children.map((p) => `/admin/${p.replace(':id', fakeId)}`)];
}

const ADMIN_SHELL = "!!document.querySelector('aside a[href=\"/admin\"]')";
const HOOKS_ERROR = /Rendered (more|fewer) hooks|error occurred in the <AdminLayout>|change in the order of Hooks|Invalid hook call/i;

const vitePort = await freePort();
const chromeMissing = findChrome() ? false : 'Chrome/Chromium not found (set CHROME_BIN to run browser tests).';
const ctx = chromeMissing
  ? { skipReason: chromeMissing, close: async () => {} }
  : await createTestContext(import.meta.url, { extraEnv: { CORS_ORIGINS: `http://127.0.0.1:${vitePort}` } });
const skip = ctx.skipReason || false;

let browser; let vite; let page; let fx; let origin;

after(async () => {
  await page?.close();
  await browser?.close();
  await vite?.close();
  await ctx.close();
});

async function useToken(token) {
  await page.goto(`${origin}/favicon.svg`);
  await page.evaluate(token ? `localStorage.setItem('arc_token', ${JSON.stringify(token)})` : "localStorage.removeItem('arc_token')");
}

function assertNoHookErrors(where) {
  const hits = [...page.exceptions, ...page.consoleErrors].filter((m) => HOOKS_ERROR.test(m) || /Uncaught/.test(m));
  assert.deepEqual(hits, [], `${where}: React errors were raised`);
}

async function expectAdminRendered(route, how) {
  const ok = await page.waitFor(`${ADMIN_SHELL} && location.pathname === ${JSON.stringify(route)}`);
  const root = await page.evaluate("document.getElementById('root').childElementCount");
  const errors = [...page.exceptions, ...page.consoleErrors].map((m) => String(m).split('\n')[0]).slice(0, 3);
  assert.ok(ok, `${how} ${route}: admin shell did not render (root children: ${root}, path: ${await page.evaluate('location.pathname')}; browser errors: ${JSON.stringify(errors)})`);
  assertNoHookErrors(`${how} ${route}`);
}

describe('Admin routing in a real browser (ADM-003)', { skip }, () => {
  before(async () => {
    fx = await ctx.seed();
    vite = await startViteDevServer({ clientDir: CLIENT_DIR, port: vitePort, apiBase: `${ctx.base}` });
    origin = vite.origin;
    browser = await launchBrowser();
    page = await browser.newPage();
  });

  test('NAV-01 every admin route renders on direct navigation and on browser refresh (admin)', async () => {
    const routes = adminRoutesFromApp();
    assert.ok(routes.length >= 45, `expected all admin routes from App.jsx, found ${routes.length}`);
    await useToken(fx.tokens.admin);
    for (const route of routes) {
      page.resetLogs();
      await page.goto(`${origin}${route}`);
      await expectAdminRendered(route, 'direct open');
      page.resetLogs();
      await page.reload();
      await expectAdminRendered(route, 'refresh');
    }
  });

  test('NAV-02 in-app navigation, then browser back and forward, keeps the admin shell rendered', async () => {
    await useToken(fx.tokens.admin);
    page.resetLogs();
    await page.goto(`${origin}/admin`);
    await expectAdminRendered('/admin', 'direct open');
    // Same steps a user takes: a section header expands its sub-links, then a sub-link is clicked.
    const clickHeader = (label) => page.evaluate(`(() => {
      const btn = [...document.querySelectorAll('aside button')].find((b) => b.textContent.trim() === ${JSON.stringify(label)});
      if (!btn) throw new Error('no sidebar header ${label}');
      btn.click();
    })()`);
    const clickLink = (to) => page.waitFor(`(() => {
      const a = document.querySelector('aside a[href="${to}"]');
      if (!a) return false;
      a.click();
      return true;
    })()`);
    await clickHeader('Orders');
    await expectAdminRendered('/admin/orders', 'sidebar header');
    assert.ok(await clickLink('/admin/orders/pending'), 'Pending Orders link');
    await expectAdminRendered('/admin/orders/pending', 'sidebar link');
    await clickHeader('Products');
    await expectAdminRendered('/admin/products', 'sidebar header');
    assert.ok(await clickLink('/admin/products/categories'), 'Categories link');
    await expectAdminRendered('/admin/products/categories', 'sidebar link');

    await page.back();
    await expectAdminRendered('/admin/products', 'back');
    await page.back();
    await expectAdminRendered('/admin/orders/pending', 'back');
    await page.forward();
    await expectAdminRendered('/admin/products', 'forward');
    await page.forward();
    await expectAdminRendered('/admin/products/categories', 'forward');
    await page.reload();
    await expectAdminRendered('/admin/products/categories', 'refresh after back/forward');
    await page.back();
    await expectAdminRendered('/admin/products', 'back after refresh');
  });

  test('NAV-03 sidebar section for the current route is expanded after a refresh', async () => {
    await useToken(fx.tokens.admin);
    await page.goto(`${origin}/admin/orders/shipped`);
    await expectAdminRendered('/admin/orders/shipped', 'direct open');
    const visible = await page.waitFor("!!document.querySelector('aside a[href=\"/admin/orders/delivered\"]')");
    assert.ok(visible, 'Orders sub-links should be expanded on an orders route');
  });

  test('NAV-04 admin content is never shown while the session check is still loading', async () => {
    await useToken(fx.tokens.admin);
    page.hold(/\/api\/auth\/me/, 1500);
    try {
      await page.goto(`${origin}/admin/orders`);
      const samples = [];
      for (let i = 0; i < 8; i += 1) {
        samples.push(await page.evaluate(ADMIN_SHELL));
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.ok(samples.every((v) => v === false), `admin shell visible before /auth/me resolved: ${samples}`);
    } finally {
      page.clearHolds();
    }
    await expectAdminRendered('/admin/orders', 'after delayed auth');
  });

  test('NAV-05 unauthenticated direct open and refresh redirect to /login without showing admin', async () => {
    await useToken(null);
    for (const route of ['/admin', '/admin/orders', '/admin/products/new']) {
      page.resetLogs();
      await page.goto(`${origin}${route}`);
      const onLogin = await page.waitFor("location.pathname === '/login'");
      assert.ok(onLogin, `${route} should redirect to /login, got ${await page.evaluate('location.pathname')}`);
      assert.equal(await page.evaluate(ADMIN_SHELL), false);
      await page.reload();
      assert.ok(await page.waitFor("location.pathname === '/login'"), 'refresh on /login stays on /login');
      assertNoHookErrors(`unauthenticated ${route}`);
    }
  });

  test('NAV-06 expired session token: redirected to /login and the stale token is cleared', async () => {
    const expired = ctx.signToken({ sub: String(fx.admin._id), role: 'admin', exp: Math.floor(Date.now() / 1000) - 60 });
    await useToken(expired);
    page.resetLogs();
    await page.goto(`${origin}/admin/products`);
    assert.ok(await page.waitFor("location.pathname === '/login'"), 'expired token should end on /login');
    assert.equal(await page.evaluate(ADMIN_SHELL), false);
    assert.equal(await page.evaluate("localStorage.getItem('arc_token')"), null);
    assertNoHookErrors('expired token');
  });

  test('NAV-07 a logged-in customer cannot open admin routes (direct open or refresh)', async () => {
    await useToken(fx.tokens.customer);
    for (const route of ['/admin', '/admin/customers', '/admin/reports/sales']) {
      page.resetLogs();
      await page.goto(`${origin}${route}`);
      const left = await page.waitFor("!location.pathname.startsWith('/admin')");
      assert.ok(left, `customer stayed on ${await page.evaluate('location.pathname')}`);
      assert.equal(await page.evaluate(ADMIN_SHELL), false, 'admin shell must not render for a customer');
      assertNoHookErrors(`customer ${route}`);
    }
  });

  test('NAV-08 after signing in from a deep admin link, the admin returns to that page', async () => {
    await useToken(null);
    await page.goto(`${origin}/admin/orders/pending`);
    assert.ok(await page.waitFor("location.pathname === '/login' && !!document.querySelector('input[type=\"password\"]')"));
    await page.evaluate(`(() => {
      const set = (el, v) => {
        const proto = Object.getPrototypeOf(el);
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      const form = document.querySelector('input[type="password"]').form;
      set(form.querySelector('input[type="email"], input[name="email"]'), ${JSON.stringify(fx.admin.email)});
      set(form.querySelector('input[type="password"]'), ${JSON.stringify(PASSWORDS.admin)});
      form.requestSubmit();
    })()`);
    await expectAdminRendered('/admin/orders/pending', 'post-login redirect');
  });

  test('NAV-09 logging out from inside the admin panel leaves it without React errors', async () => {
    await useToken(fx.tokens.admin);
    page.resetLogs();
    await page.goto(`${origin}/admin/orders`);
    await expectAdminRendered('/admin/orders', 'direct open');
    // Real logout flow: in-app navigation to the logout page, then the confirmation button.
    await page.evaluate("history.pushState({}, '', '/account/logout'); dispatchEvent(new PopStateEvent('popstate'))");
    const clicked = await page.waitFor(`(() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Logout');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    assert.ok(clicked, 'logout confirmation button not found');
    assert.ok(await page.waitFor("location.pathname === '/login' && localStorage.getItem('arc_token') === null"));
    await page.evaluate("history.pushState({}, '', '/admin/orders'); dispatchEvent(new PopStateEvent('popstate'))");
    assert.ok(await page.waitFor("location.pathname === '/login'"), 'admin route after logout should redirect to /login');
    assert.equal(await page.evaluate(ADMIN_SHELL), false);
    assertNoHookErrors('after logout');
  });

  test('NAV-10 no request left the machine during browser tests', () => {
    const external = page.blocked.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u));
    assert.deepEqual(external, [], 'only Google Fonts requests are expected (and they are blocked)');
  });
});
