// End-to-end tests for the admin order screens and dashboard (Phase 5F) in real headless Chrome.
// Real UI + real API + isolated MongoDB (replica set). Only a few dashboard responses are answered
// locally inside Chrome (page.mock) to exercise empty and failure states; nothing leaves the machine.
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

let browser; let vite; let page; let fx; let origin;
after(async () => {
  await page?.close();
  await browser?.close();
  await vite?.close();
  await ctx.close();
});

const q = (s) => JSON.stringify(s);
const text = () => page.evaluate('document.body.innerText');
const testid = (id) => `[data-testid="${id}"]`;
const textOf = (sel) => page.evaluate(`document.querySelector(${q(sel)})?.textContent?.trim() ?? null`);
const rows = () => page.evaluate("[...document.querySelectorAll('[data-testid=\"order-row\"] [data-testid=\"order-number\"]')].map((e) => e.textContent.trim())");
/** API calls made by the current document (from the browser's own resource timing). */
const apiCalls = () => page.evaluate("performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/api/'))");

async function open(route) { await page.goto(`${origin}${route}`); }
async function fill(selector, value) {
  assert.ok(await page.waitFor(`!!document.querySelector(${q(selector)})`), `field ${selector} never appeared`);
  await page.evaluate(`(() => {
    const el = document.querySelector(${q(selector)});
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${q(String(value))});
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement || el.type === 'date' ? 'change' : 'input', { bubbles: true }));
  })()`);
}
async function click(selector) {
  const ok = await page.waitFor(`(() => { const el = document.querySelector(${q(selector)}); if (!el || el.disabled) return false; el.click(); return true; })()`);
  assert.ok(ok, `could not click ${selector}`);
}
async function waitRows(n, note) {
  const ok = await page.waitFor(`document.querySelectorAll('[data-testid="order-row"]').length === ${n} && document.querySelector('tbody')?.getAttribute('aria-busy') === 'false'`);
  assert.ok(ok, `${note}: expected ${n} rows, saw ${JSON.stringify(await rows())}`);
}
const waitText = async (sel, pattern, note) => {
  const ok = await page.waitFor(`(() => { const t = document.querySelector(${q(sel)})?.textContent || ''; return ${pattern}.test(t); })()`);
  assert.ok(ok, `${note}: ${sel} = ${JSON.stringify(await textOf(sel))}`);
};

describe('Admin order screens in the browser', { skip: ctx.skipReason }, () => {
  let raw;
  let seq = 0;
  const docs = [];
  function makeOrder(over = {}) {
    seq += 1;
    return {
      _id: new ctx.mongoose.Types.ObjectId(),
      orderNumber: `AL${60000 + seq}`,
      user: fx.customer._id,
      customerName: `Customer ${String(seq).padStart(2, '0')}`,
      customerEmail: `buyer${seq}@example.in`,
      customerPhone: `98200${String(10000 + seq)}`,
      items: [{ product: fx.lace._id, title: 'Test Gold Lace', price: 100, quantity: 2, unit: 'meter' }],
      subtotal: 200, shipping: 0, total: 200,
      paymentMethod: 'cod', paymentStatus: 'pending', status: 'pending',
      shippingAddress: { fullName: 'Ship Name', line1: '12 Lace Lane', city: 'Surat', state: 'Gujarat', pincode: '395003', phone: '9000000000' },
      createdAt: new Date(Date.UTC(2026, 9, 1, 6, seq)), updatedAt: new Date(),
      ...over,
    };
  }

  before(async () => {
    fx = await ctx.seed();
    raw = ctx.mongoose.connection.db.collection('orders');
    // 33 orders: more than one 20-row page, with known revenue figures.
    for (let i = 0; i < 25; i += 1) docs.push(makeOrder({ status: ['pending', 'processing', 'shipped', 'delivered'][i % 4] }));
    docs.push(makeOrder({ status: 'delivered', paymentStatus: 'paid', paymentMethod: 'razorpay', total: 1000, razorpayPaymentId: 'pay_E2E' }));
    docs.push(makeOrder({ status: 'shipped', paymentStatus: 'paid', paymentMethod: 'razorpay', total: 500 }));
    docs.push(makeOrder({ status: 'cancelled', paymentStatus: 'paid', paymentMethod: 'razorpay', total: 300 }));
    docs.push(makeOrder({ status: 'cancelled', paymentStatus: 'pending', total: 700 }));
    docs.push(makeOrder({ status: 'pending', customerName: 'Meera Textiles', customerEmail: 'meera@shop.in', total: 450 }));
    docs.push(makeOrder({ status: 'pending', createdAt: new Date('2026-03-09T18:30:00Z') })); // 10 Mar IST
    // A historical order with almost nothing recorded.
    docs.push({ _id: new ctx.mongoose.Types.ObjectId(), orderNumber: 'AL10003', items: [{ title: 'Old Trim', price: 50, quantity: 3 }], total: 150, status: 'delivered', createdAt: new Date('2025-01-02T05:00:00Z') });
    docs.push(makeOrder({ status: 'pending', orderNumber: 'AL60100' }));
    await raw.insertMany(docs);

    vite = await startViteDevServer({ clientDir: CLIENT_DIR, port: vitePort, apiBase: ctx.base });
    origin = vite.origin;
    browser = await launchBrowser();
    page = await browser.newPage();
    await page.goto(`${origin}/favicon.svg`);
    await page.evaluate(`localStorage.setItem('arc_token', ${q(fx.tokens.admin)})`);
  });

  const unpaidExpected = () => docs.filter((d) => d.status !== 'cancelled' && d.paymentStatus !== 'paid').reduce((s, d) => s + d.total, 0);
  const inr = (n) => `₹${n.toLocaleString('en-IN')}`;

  test('AO-01 dashboard totals come from /orders/stats (all 33 orders, not a 20-row page)', async () => {
    await open('/admin');
    await waitText(testid('stat-Total Orders'), '/^33$/', 'total orders');
    assert.equal(await textOf(testid('stat-Paid Revenue')), inr(1500), 'paid revenue excludes the cancelled paid order and all unpaid ones');
    assert.equal(await textOf(testid('stat-Unpaid Order Value')), inr(unpaidExpected()), 'unpaid value excludes cancelled orders');
    assert.equal(await textOf(testid('stat-Average Paid Order')), inr(750));
    assert.equal(await textOf(`${testid('status-count-cancelled')} span:last-child`), '2');
    assert.match(await textOf(testid('cancelled-paid')), /1 cancelled order is still marked paid \(₹300\)/);
    assert.equal(await page.evaluate("document.querySelectorAll('[data-testid=\"recent-orders\"] li').length"), 5);
    const calls = await apiCalls();
    assert.ok(calls.some((u) => u.includes('/api/orders/stats')), 'stats endpoint used');
    assert.ok(!calls.some((u) => /\/api\/orders(\?|$)/.test(u)), `no order-list request for totals: ${calls}`);
  });

  test('AO-02 dashboard: empty statistics and an API failure are handled', async () => {
    const empty = {
      range: { from: null, to: null, timezone: 'Asia/Kolkata' },
      orders: { total: 0, byStatus: { pending: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0 } },
      revenue: { currency: 'INR', paid: 0, paidOrders: 0, averagePaidOrderValue: 0, unpaid: 0, unpaidOrders: 0, cancelledPaid: 0, cancelledPaidOrders: 0 },
      catalog: { activeProducts: 0, totalProducts: 0, activeCategories: 0, totalCategories: 0 },
      recentOrders: [],
    };
    page.mock('GET', /\/api\/orders\/stats/, () => ({ status: 200, body: empty }));
    await open('/admin');
    await waitText(testid('stat-Total Orders'), '/^0$/', 'zero orders');
    assert.equal(await textOf(testid('stat-Paid Revenue')), '₹0');
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('no-orders'))})`), 'empty recent orders message');

    page.clearMocks();
    page.mock('GET', /\/api\/orders\/stats/, () => ({ status: 500, body: { message: 'Server error' } }));
    await open('/admin');
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('dashboard-error'))})`), 'error shown');
    assert.equal(await textOf(testid('stat-Total Orders')), '—', 'no fabricated numbers on failure');
    page.clearMocks();
    await click(`${testid('dashboard-error')} button`);
    await waitText(testid('stat-Total Orders'), '/^33$/', 'retry loads real data');
  });

  test('AO-03 the order list shows real orders with server-side pagination', async () => {
    await open('/admin/orders');
    await waitRows(20, 'page 1');
    assert.match(await textOf(testid('pagination-summary')), /Showing 1–20 of 33 orders/);
    assert.equal((await rows())[0], '#AL60100', 'newest first');
    assert.match(await textOf(testid('count-all')), /33/);
    await click('button[aria-label="Next page"]');
    await waitRows(13, 'page 2');
    assert.match(await page.evaluate('location.search'), /page=2/);
    assert.ok((await apiCalls()).some((u) => /\/api\/orders\?.*page=2/.test(u)), 'backend asked for page 2');
    await page.reload();
    await waitRows(13, 'page 2 after refresh');
    await fill('select[aria-label="Per page"]', '50');
    await waitRows(33, '50 per page');
    assert.doesNotMatch(await page.evaluate('location.search'), /page=/, 'page reset');
    const body = await text();
    assert.ok(!body.includes('12 Lace Lane'), 'addresses are not shown in the list');
  });

  test('AO-04 search and filters reach the backend and reset pagination', async () => {
    await open('/admin/orders?page=2');
    await waitRows(13, 'start on page 2');
    await fill('input[aria-label="Search orders"]', 'meera@shop');
    await waitRows(1, 'email search');
    assert.equal((await rows())[0], `#${docs.find((d) => d.customerName === 'Meera Textiles').orderNumber}`);
    const search = await page.evaluate('location.search');
    assert.match(search, /q=meera%40shop/);
    assert.doesNotMatch(search, /page=/, 'search resets to page 1');
    assert.ok((await apiCalls()).some((u) => /\/api\/orders\?q=meera%40shop/.test(u)));

    await fill('input[aria-label="Search orders"]', 'AL60026');
    await waitRows(1, 'order number search');
    await fill('input[aria-label="Search orders"]', '');
    await waitRows(20, 'search cleared');

    await fill('select[aria-label="Status"]', 'cancelled');
    await waitRows(2, 'status filter');
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('[data-testid=\"order-status\"]')].map((e) => e.textContent)"), ['Cancelled', 'Cancelled']);
    await fill('select[aria-label="Payment status"]', 'paid');
    await waitRows(1, 'status + payment');
    assert.match(await page.evaluate('location.search'), /status=cancelled.*paymentStatus=paid|paymentStatus=paid.*status=cancelled/);
    await click(testid('clear-filters'));
    await waitRows(20, 'filters cleared');

    await fill('input[aria-label="From date"]', '2026-03-10');
    assert.ok(await page.waitFor("location.search.includes('from=2026-03-10')"), 'from applied');
    await fill('input[aria-label="To date"]', '2026-03-10');
    await waitRows(1, 'IST date range');
    assert.ok((await apiCalls()).some((u) => /from=2026-03-10/.test(u) && /to=2026-03-10/.test(u)));
  });

  test('AO-05 empty results and status routes (deep link + refresh)', async () => {
    await open('/admin/orders?q=no-such-order-anywhere');
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('empty-state'))})`));
    assert.match(await textOf(testid('empty-state')), /No orders match/);
    assert.match(await textOf(testid('pagination-summary')), /No orders/);

    await open('/admin/orders/cancelled');
    await waitRows(2, 'cancelled route');
    assert.equal(await textOf(testid('orders-title')), 'Cancelled Orders');
    assert.ok(!(await page.evaluate("!!document.querySelector('select[aria-label=\"Status\"]')")), 'status is fixed on status routes');
    await page.reload();
    await waitRows(2, 'cancelled route after refresh');
    await open('/admin/orders/shipped');
    await waitRows(docs.filter((d) => d.status === 'shipped').length, 'shipped route');
  });

  test('AO-06 order detail loads by id from the list, and survives a refresh', async () => {
    const paid = docs.find((d) => d.razorpayPaymentId === 'pay_E2E');
    await open(`/admin/orders?q=${paid.orderNumber}`);
    await waitRows(1, 'find order');
    await click(`${testid('order-row')} a`);
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('order-detail'))})`));
    assert.equal(await page.evaluate('location.pathname'), `/admin/orders/${paid._id}`);
    assert.equal(await textOf(testid('order-title')), `Order #${paid.orderNumber}`);
    assert.equal(await textOf(testid('detail-payment')), 'Paid');
    assert.equal(await textOf(testid('detail-total')), '₹1,000');
    const body = await text();
    for (const expected of ['12 Lace Lane', 'Surat, Gujarat', 'Test Gold Lace', 'pay_E2E', paid.customerEmail]) assert.ok(body.includes(expected), expected);
    await page.reload();
    assert.ok(await page.waitFor(`document.querySelector(${q(testid('order-title'))})?.textContent === ${q(`Order #${paid.orderNumber}`)}`), 'deep link after refresh');
  });

  test('AO-07 malformed and unknown order ids show clear errors', async () => {
    await open('/admin/orders/not-a-real-id');
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('order-invalid'))})`), 'invalid id');
    await open(`/admin/orders/${new ctx.mongoose.Types.ObjectId()}`);
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('order-missing'))})`), 'missing order');
  });

  test('AO-08 a historical order with missing fields renders without crashing', async () => {
    const legacy = docs.find((d) => d.orderNumber === 'AL10003');
    page.resetLogs();
    await open(`/admin/orders/${legacy._id}`);
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('order-detail'))})`));
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('stock-not-recorded'))})`));
    const body = await text();
    assert.ok(body.includes('Old Trim') && body.includes('No shipping address recorded') && body.includes('No linked customer account'));
    assert.equal(await textOf(testid('status-final')), 'This order is delivered; its status can no longer change.');
    assert.deepEqual(page.exceptions, []);
  });

  test('AO-09 valid status changes are confirmed, applied by the server and refreshed', async () => {
    const order = docs.find((d) => d.status === 'pending' && d.orderNumber !== 'AL60100' && !d.customerName.startsWith('Meera'));
    await open(`/admin/orders/${order._id}`);
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('status-actions'))})`));
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('[data-testid=\"status-actions\"] button')].map((b) => b.textContent)"), ['Mark as processing', 'Mark as shipped', 'Cancel order']);
    await click(testid('action-processing'));
    await click(testid('confirm-cancel')); // changing your mind does nothing
    assert.equal((await raw.findOne({ _id: order._id })).status, 'pending');

    await click(testid('action-processing'));
    // Two clicks in the same tick must send one request.
    await page.evaluate(`(() => { const b = document.querySelector(${q(testid('confirm-apply'))}); b.click(); b.click(); })()`);
    await waitText(testid('detail-status'), '/^Processing$/', 'status refreshed');
    assert.match(await textOf(testid('toast')), /marked as processing/);
    assert.equal((await raw.findOne({ _id: order._id })).status, 'processing');
    assert.equal((await apiCalls()).filter((u) => u.endsWith(`/api/orders/${order._id}/status`)).length, 1, 'one PATCH');
    assert.deepEqual(await page.evaluate("[...document.querySelectorAll('[data-testid=\"status-actions\"] button')].map((b) => b.textContent)"), ['Mark as shipped', 'Cancel order']);
  });

  test('AO-10 cancelling a checkout order returns its reserved stock, as reported by the server', async () => {
    await ctx.models.Product.updateOne({ _id: fx.trim._id }, { stock: 10 });
    const placed = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.trim._id), quantity: 3 }]);
    assert.equal(placed.status, 201);
    assert.equal((await ctx.models.Product.findById(fx.trim._id)).stock, 7);
    await open(`/admin/orders/${placed.body.order._id}`);
    await click(testid('action-cancelled'));
    assert.match(await textOf(testid('confirm-message')), /3 reserved units will be returned to stock/);
    await click(testid('confirm-apply'));
    await waitText(testid('detail-status'), '/^Cancelled$/', 'cancelled');
    assert.match(await textOf(testid('toast')), /Reserved stock was returned/);
    assert.equal((await ctx.models.Product.findById(fx.trim._id)).stock, 10);
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('cancellation'))})`));
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('status-final'))})`), 'no further actions');
  });

  test('AO-11 a transition rejected by the server shows its message and no success', async () => {
    const order = docs.find((d) => d.orderNumber === 'AL60100');
    await open(`/admin/orders/${order._id}`);
    assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('action-processing'))})`));
    // Another admin delivers the order while this page is open.
    await raw.updateOne({ _id: order._id }, { $set: { status: 'shipped' } });
    await raw.updateOne({ _id: order._id }, { $set: { status: 'delivered' } });
    await click(testid('action-processing'));
    await click(testid('confirm-apply'));
    await waitText(testid('action-error'), '/delivered order is final/', 'backend message shown');
    assert.equal(await page.evaluate(`!!document.querySelector(${q(testid('toast'))})`), false, 'no success toast');
    await waitText(testid('detail-status'), '/^Delivered$/', 'shows the real current status');
    assert.equal((await raw.findOne({ _id: order._id })).status, 'delivered');
  });

  // Since Phase 5F.1 the admin sidebar is a drawer below 1024px, so the order screens get the full
  // phone width. Their own content must fit, with the table scrolling inside its container.
  test('AO-12 phone width (390px): list and detail content fits the screen', async () => {
    await page.cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    try {
      // Elements of the order screen that stick out of the page's content area without being inside a
      // scrollable container.
      const overflow = (rootSel) => page.evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(rootSel)});
        const W = root ? root.getBoundingClientRect().right : window.innerWidth;
        if (!root) return ['root missing'];
        const bad = [];
        for (const el of [root, ...root.querySelectorAll('*')]) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.right <= W + 1) continue;
          let scrolls = false;
          for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
            if (['auto', 'scroll', 'hidden'].includes(getComputedStyle(a).overflowX)) { scrolls = true; break; }
          }
          if (!scrolls) bad.push(el.tagName + ' ' + String(el.className).slice(0, 40) + ' right=' + Math.round(r.right));
        }
        return bad.slice(0, 5);
      })()`);
      await open('/admin/orders');
      await waitRows(20, 'mobile list');
      assert.deepEqual(await overflow('[data-testid="orders-page"]'), [], 'order list content fits the screen');
      assert.ok(await page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no page-level horizontal scroll');
      assert.ok(await page.evaluate("document.querySelector('main').getBoundingClientRect().width === window.innerWidth"), 'content uses the full phone width');
      assert.ok(await page.evaluate("(() => { const r = document.querySelector('input[aria-label=\"Search orders\"]').getBoundingClientRect(); return r.width > 150 && r.right <= window.innerWidth; })()"), 'search usable');
      assert.ok(await page.evaluate("getComputedStyle(document.querySelector('table').parentElement).overflowX === 'auto'"), 'table scrolls inside its container');
      await open(`/admin/orders/${docs[0]._id}`);
      assert.ok(await page.waitFor(`!!document.querySelector(${q(testid('order-detail'))})`));
      assert.deepEqual(await overflow('[data-testid="order-detail"]'), [], 'order detail content fits the screen');
    } finally {
      await page.cdp('Emulation.clearDeviceMetricsOverride', {});
    }
  });

  test('AO-13 customers cannot open admin order screens', async () => {
    await page.evaluate(`localStorage.setItem('arc_token', ${q(fx.tokens.customer)})`);
    try {
      for (const route of ['/admin', '/admin/orders', `/admin/orders/${docs[0]._id}`]) {
        await open(route);
        assert.ok(await page.waitFor("location.pathname === '/'"), `${route} redirects customers home`);
        assert.ok(!(await text()).includes('Order #'), route);
      }
    } finally {
      await page.evaluate(`localStorage.setItem('arc_token', ${q(fx.tokens.admin)})`);
    }
  });

  test('AO-14 no uncaught errors; nothing left the machine', () => {
    assert.deepEqual(page.exceptions, []);
    const external = page.blocked.filter((u) => !/^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(u));
    assert.deepEqual(external, []);
    assert.ok(page.mocked.every((u) => u.includes('/api/orders/stats')), 'only the dashboard stats were mocked');
  });
});
