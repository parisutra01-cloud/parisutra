// Admin order APIs (Milestone 5E): paginated/filterable/searchable list, order detail and dashboard
// statistics. Orders are inserted directly into the throwaway database where exact timestamps and
// payment states are needed; the real checkout API is used where the stored shape matters.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

const SUMMARY_KEYS = ['_id', 'cancelledAt', 'createdAt', 'customerEmail', 'customerName', 'customerPhone', 'itemCount', 'orderNumber',
  'paymentMethod', 'paymentStatus', 'shipping', 'status', 'subtotal', 'total', 'totalQuantity', 'updatedAt'];

describe('Admin order APIs', { skip: ctx.skipReason }, () => {
  let fx;
  let raw; // native orders collection: exact createdAt values, no Mongoose defaults
  let seq = 0;
  const get = (path, token = fx.tokens.admin) => ctx.request('GET', path, { token });
  const ids = (res) => res.body.orders.map((o) => o._id);
  function makeOrder(over = {}) {
    seq += 1;
    return {
      _id: new ctx.mongoose.Types.ObjectId(),
      orderNumber: `AL${70000 + seq}`,
      user: fx.customer._id,
      customerName: 'Test Customer',
      customerEmail: 'customer@parisutra.test',
      customerPhone: '9999999999',
      items: [{ product: fx.lace._id, title: 'Test Gold Lace', price: 100, quantity: 1 }],
      subtotal: 100, shipping: 0, total: 100,
      paymentMethod: 'cod', paymentStatus: 'pending', status: 'pending',
      createdAt: new Date(Date.UTC(2026, 0, 1) + seq * 60000), updatedAt: new Date(),
      ...over,
    };
  }
  const reset = async (docs) => { await raw.deleteMany({}); if (docs.length) await raw.insertMany(docs); };

  before(async () => {
    fx = await ctx.seed();
    raw = ctx.mongoose.connection.db.collection('orders');
  });

  describe('dashboard on an empty store', () => {
    test('ST-01 no orders: every metric is a valid zero', async () => {
      await reset([]);
      const res = await get('/orders/stats');
      expectStatus(assert, res, 200);
      assert.deepEqual(res.body.orders, { total: 0, byStatus: { pending: 0, processing: 0, shipped: 0, delivered: 0, cancelled: 0 } });
      assert.deepEqual(res.body.revenue, { currency: 'INR', paid: 0, paidOrders: 0, averagePaidOrderValue: 0, unpaid: 0, unpaidOrders: 0, cancelledPaid: 0, cancelledPaidOrders: 0 });
      assert.deepEqual(res.body.recentOrders, []);
      assert.deepEqual(res.body.range, { from: null, to: null, timezone: 'Asia/Kolkata' });
      const list = await get('/orders');
      assert.deepEqual(list.body, { orders: [], pagination: { page: 1, limit: 20, total: 0, pages: 0, hasPrev: false, hasNext: false } });
    });
  });

  describe('order list', () => {
    let docs;
    before(async () => {
      docs = Array.from({ length: 45 }, (_, i) => makeOrder({
        status: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'][i % 5],
        paymentStatus: i % 3 === 0 ? 'paid' : 'pending',
      }));
      // Three orders with the identical timestamp exercise the _id tie-breaker.
      const tie = new Date(Date.UTC(2026, 5, 1));
      for (const d of docs.slice(0, 3)) d.createdAt = tie;
      await reset(docs);
    });
    const expectedOrder = () => [...docs].sort((a, b) => (b.createdAt - a.createdAt) || (String(b._id) < String(a._id) ? -1 : 1)).map((d) => String(d._id));

    test('OA-01 defaults: page 1, 20 per page, newest first, metadata and an allowlisted summary', async () => {
      const res = await get('/orders');
      expectStatus(assert, res, 200);
      assert.deepEqual(res.body.pagination, { page: 1, limit: 20, total: 45, pages: 3, hasPrev: false, hasNext: true });
      assert.deepEqual(ids(res), expectedOrder().slice(0, 20));
      assert.deepEqual(Object.keys(res.body.orders[0]).sort(), SUMMARY_KEYS);
      const json = JSON.stringify(res.body);
      for (const hidden of ['shippingAddress', 'razorpay', 'stockReservation', '"items"', '"user"']) assert.ok(!json.includes(hidden), hidden);
    });

    test('OA-02 walking every page returns each order exactly once in a stable order (ties broken by _id)', async () => {
      const seen = [];
      for (let page = 1; ; page += 1) {
        const res = await get(`/orders?limit=7&page=${page}`);
        expectStatus(assert, res, 200);
        seen.push(...ids(res));
        assert.equal(res.body.pagination.hasPrev, page > 1);
        if (!res.body.pagination.hasNext) { assert.equal(page, 7); break; }
      }
      assert.deepEqual(seen, expectedOrder());
      const beyond = await get('/orders?limit=7&page=99');
      expectStatus(assert, beyond, 200);
      assert.deepEqual(beyond.body.orders, []);
      assert.equal(beyond.body.pagination.hasNext, false);
      assert.equal(beyond.body.pagination.total, 45);
    });

    test('OA-03 page and limit boundaries', async () => {
      expectStatus(assert, await get('/orders?limit=100'), 200);
      assert.equal((await get('/orders?limit=100')).body.orders.length, 45);
      assert.equal((await get('/orders?limit=1')).body.orders.length, 1);
      for (const q of ['limit=101', 'limit=0', 'limit=-1', 'limit=1.5', 'limit=abc', 'page=0', 'page=-2', 'page=x', 'limit[]=5', 'page[$gt]=0', 'limit=5&limit=6']) {
        const res = await get(`/orders?${q}`);
        expectStatus(assert, res, 400, q);
        assert.equal(typeof res.body.message, 'string');
      }
    });

    test('OA-04 status and payment-status filters with accurate totals', async () => {
      for (const s of ['pending', 'processing', 'shipped', 'delivered', 'cancelled']) {
        const res = await get(`/orders?status=${s}&limit=100`);
        assert.equal(res.body.pagination.total, docs.filter((d) => d.status === s).length, s);
        assert.ok(res.body.orders.every((o) => o.status === s));
      }
      const paid = await get('/orders?paymentStatus=paid&limit=100');
      assert.equal(paid.body.pagination.total, docs.filter((d) => d.paymentStatus === 'paid').length);
      const both = await get('/orders?paymentStatus=paid&status=delivered&limit=100');
      assert.equal(both.body.pagination.total, docs.filter((d) => d.paymentStatus === 'paid' && d.status === 'delivered').length);
      for (const q of ['status=teleported', 'paymentStatus=refunded', 'paymentStatus[$ne]=paid', 'status[]=pending']) {
        expectStatus(assert, await get(`/orders?${q}`), 400, q);
      }
    });

    test('OA-05 date filters use whole IST calendar days', async () => {
      // 2026-03-09 23:59:59.999 IST and 2026-03-10 00:00 IST.
      const late = makeOrder({ createdAt: new Date('2026-03-09T18:29:59.999Z') });
      const early = makeOrder({ createdAt: new Date('2026-03-09T18:30:00.000Z') });
      await raw.insertMany([late, early]);
      try {
        const day9 = await get('/orders?from=2026-03-09&to=2026-03-09');
        assert.deepEqual(ids(day9), [String(late._id)]);
        const day10 = await get('/orders?from=2026-03-10&to=2026-03-10');
        assert.deepEqual(ids(day10), [String(early._id)]);
        const both = await get('/orders?from=2026-03-09&to=2026-03-10');
        assert.deepEqual(ids(both), [String(early._id), String(late._id)]);
        assert.equal((await get('/orders?from=2026-03-10&limit=100')).body.pagination.total, 1 + docs.filter((d) => d.createdAt >= new Date('2026-03-09T18:30:00Z')).length);
        assert.equal((await get('/orders?to=2026-03-09&limit=100')).body.pagination.total, 1 + docs.filter((d) => d.createdAt < new Date('2026-03-09T18:30:00Z')).length);
      } finally {
        await raw.deleteMany({ _id: { $in: [late._id, early._id] } });
      }
    });

    test('OA-06 malformed dates and reversed ranges are rejected', async () => {
      for (const q of ['from=2026-02-30', 'from=2026-13-01', 'to=10-03-2026', 'from=yesterday', 'to=2026-3-1', 'from=2026-03-10T00:00:00Z',
        'from=2026-03-10&to=2026-03-09', 'from[$gt]=2026-01-01', 'to[]=2026-01-01']) {
        expectStatus(assert, await get(`/orders?${q}`), 400, q);
      }
      expectStatus(assert, await get('/orders?from=2024-02-29&to=2024-02-29'), 200, 'leap day');
    });

    test('OA-07 search: order number, customer name/email/phone, combined with filters', async () => {
      const special = makeOrder({ orderNumber: 'AL99999', customerName: 'Meera A+B (Ltd)', customerEmail: 'meera.shop@example.in', customerPhone: '+91 98200 11111', status: 'shipped' });
      await raw.insertOne(special);
      try {
        const one = (res) => assert.deepEqual(ids(res), [String(special._id)]);
        one(await get('/orders?q=AL99999'));
        one(await get('/orders?q=al99999'));
        one(await get('/orders?q=a%2Bb%20(ltd)'));
        one(await get('/orders?q=MEERA.SHOP'));
        one(await get('/orders?q=98200%2011111'));
        one(await get('/orders?q=meera&status=shipped'));
        assert.deepEqual(ids(await get('/orders?q=meera&status=pending')), []);
        // Regex metacharacters are literal: ".*" matches nothing here; "AL7" is a prefix, not a pattern.
        assert.deepEqual(ids(await get('/orders?q=.*')), []);
        assert.deepEqual(ids(await get('/orders?q=(%5Bx')), []);
        assert.equal((await get('/orders?q=AL7&limit=100')).body.pagination.total, 45);
        assert.equal((await get('/orders?q=test%20customer&limit=100')).body.pagination.total, 45);
        expectStatus(assert, await get(`/orders?q=${'x'.repeat(101)}`), 400);
        expectStatus(assert, await get('/orders?q[$regex]=.*'), 400);
        expectStatus(assert, await get('/orders?q=a&q=b'), 400);
      } finally {
        await raw.deleteOne({ _id: special._id });
      }
    });

    test('OA-08 empty results and access control', async () => {
      const none = await get('/orders?q=no-such-customer');
      expectStatus(assert, none, 200);
      assert.deepEqual(none.body, { orders: [], pagination: { page: 1, limit: 20, total: 0, pages: 0, hasPrev: false, hasNext: false } });
      const anyId = String(docs[0]._id);
      for (const path of ['/orders', '/orders/stats', `/orders/${anyId}`]) {
        expectStatus(assert, await ctx.request('GET', path), 401, `anon ${path}`);
        expectStatus(assert, await get(path, fx.tokens.customer), 403, `customer ${path}`);
      }
    });
  });

  describe('order detail', () => {
    test('OD-01 detail of a checkout order: snapshots, customer, address, payment, reservation', async () => {
      await reset([]);
      await ctx.models.Product.updateOne({ _id: fx.lace._id }, { stock: 50 });
      const placed = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 3 }]);
      expectStatus(assert, placed, 201);
      // Later price changes must not alter the saved snapshot.
      await ctx.models.Product.updateOne({ _id: fx.lace._id }, { price: 999, title: 'Renamed Lace' });
      const res = await get(`/orders/${placed.body.order._id}`);
      expectStatus(assert, res, 200);
      const o = res.body.order;
      assert.equal(o.orderNumber, placed.body.order.orderNumber);
      assert.deepEqual(o.items.map((i) => [i.title, i.price, i.quantity, i.lineTotal]), [['Test Gold Lace', 500, 3, 1500]]);
      assert.deepEqual(o.customer, { _id: String(fx.customer._id), name: fx.customer.name, email: 'customer@parisutra.test' });
      assert.equal(o.shippingAddress.pincode, '400001');
      assert.deepEqual(o.payment, { method: 'cod', status: 'pending', razorpayOrderId: null, razorpayPaymentId: null });
      assert.equal(o.stockReservation.recorded, true);
      assert.deepEqual(o.stockReservation.lines, [{ product: String(fx.lace._id), quantity: 3 }]);
      assert.equal(o.stockReservation.restoredAt, null);
      const json = JSON.stringify(res.body);
      for (const secret of ['password', '__v', 'role', 'googleId']) assert.ok(!json.includes(secret), secret);
      await ctx.models.Product.updateOne({ _id: fx.lace._id }, { price: 500, title: 'Test Gold Lace' });

      // After cancellation the restoration state is visible.
      await ctx.request('PATCH', `/orders/${o._id}/status`, { token: fx.tokens.admin, body: { status: 'cancelled' } });
      const after = (await get(`/orders/${o._id}`)).body.order;
      assert.equal(after.status, 'cancelled');
      assert.equal(after.cancelledBy, 'admin');
      assert.ok(after.stockReservation.restoredAt);
    });

    test('OD-02 malformed id → 400, unknown id → 404; /my, /track and /stats keep their own routes', async () => {
      expectStatus(assert, await get('/orders/not-an-id'), 400);
      expectStatus(assert, await get(`/orders/${new ctx.mongoose.Types.ObjectId()}`), 404);
      expectStatus(assert, await get('/orders/my', fx.tokens.customer), 200);
      expectStatus(assert, await get('/orders/stats'), 200);
      expectStatus(assert, await ctx.request('GET', '/orders/track'), 400);
    });

    test('OD-03 a historical order missing newer fields is readable without invented data', async () => {
      const legacy = { _id: new ctx.mongoose.Types.ObjectId(), orderNumber: 'AL10007', items: [{ product: fx.lace._id, title: 'Old Lace', price: 80, quantity: 2 }], total: 160, status: 'delivered', createdAt: new Date('2025-01-05T10:00:00Z') };
      await raw.insertOne(legacy);
      const res = await get(`/orders/${legacy._id}`);
      expectStatus(assert, res, 200);
      const o = res.body.order;
      assert.equal(o.customer, null);
      assert.equal(o.shippingAddress, null);
      assert.equal(o.customerEmail, null);
      assert.equal(o.subtotal, null);
      assert.deepEqual(o.stockReservation, { recorded: false });
      assert.equal(o.cancelledBy, null);
      assert.deepEqual(o.items[0], { product: String(fx.lace._id), title: 'Old Lace', image: null, unit: null, price: 80, quantity: 2, lineTotal: 160, variationLabel: null });
      // It also appears in the list with explicit nulls.
      const listed = (await get('/orders?q=AL10007')).body.orders[0];
      assert.equal(listed.customerName, null);
      assert.equal(listed.totalQuantity, 2);
    });

    test('OD-04 Razorpay references are shown to admins only; tracking stays minimal', async () => {
      const paid = makeOrder({ orderNumber: 'AL88001', paymentMethod: 'razorpay', paymentStatus: 'paid', razorpayOrderId: 'order_TEST123', razorpayPaymentId: 'pay_TEST456' });
      await raw.insertOne(paid);
      const res = await get(`/orders/${paid._id}`);
      assert.deepEqual(res.body.order.payment, { method: 'razorpay', status: 'paid', razorpayOrderId: 'order_TEST123', razorpayPaymentId: 'pay_TEST456' });
      const track = await ctx.request('GET', '/orders/track?orderNumber=AL88001&email=customer@parisutra.test');
      expectStatus(assert, track, 200);
      assert.ok(!JSON.stringify(track.body).includes('pay_TEST456'));
    });
  });

  describe('dashboard statistics', () => {
    test('ST-02 counts and revenue rules: cancelled and unpaid orders are never paid revenue', async () => {
      await reset([
        makeOrder({ status: 'delivered', paymentStatus: 'paid', paymentMethod: 'razorpay', total: 1000 }),
        makeOrder({ status: 'pending', paymentStatus: 'paid', paymentMethod: 'razorpay', total: 500 }),
        makeOrder({ status: 'cancelled', paymentStatus: 'paid', paymentMethod: 'razorpay', total: 300 }),
        makeOrder({ status: 'pending', paymentStatus: 'pending', total: 200 }),
        makeOrder({ status: 'delivered', paymentStatus: 'pending', total: 400 }), // delivered COD is NOT assumed paid
        makeOrder({ status: 'cancelled', paymentStatus: 'pending', total: 700 }),
        makeOrder({ status: 'processing', paymentStatus: 'failed', total: 50 }),
        makeOrder({ status: 'shipped', paymentStatus: 'pending', total: 125.25 }),
      ]);
      const res = await get('/orders/stats');
      expectStatus(assert, res, 200);
      assert.deepEqual(res.body.orders, { total: 8, byStatus: { pending: 2, processing: 1, shipped: 1, delivered: 2, cancelled: 2 } });
      assert.deepEqual(res.body.revenue, {
        currency: 'INR', paid: 1500, paidOrders: 2, averagePaidOrderValue: 750,
        unpaid: 775.25, unpaidOrders: 4, cancelledPaid: 300, cancelledPaidOrders: 1,
      });
    });

    test('ST-03 catalogue counts are real totals, not a six-item page', async () => {
      for (let i = 0; i < 15; i += 1) await ctx.models.Product.create({ title: `Stat Product ${i}`, slug: `stat-product-${i}`, category: fx.laces._id, price: 10 });
      await ctx.models.Product.create({ title: 'Stat Inactive', slug: 'stat-inactive', category: fx.laces._id, price: 10, isActive: false });
      await ctx.models.Category.create({ name: 'Stat Hidden', slug: 'stat-hidden', isActive: false });
      const res = await get('/orders/stats');
      assert.deepEqual(res.body.catalog, {
        activeProducts: await ctx.models.Product.countDocuments({ isActive: { $ne: false } }),
        totalProducts: await ctx.models.Product.countDocuments(),
        activeCategories: 2,
        totalCategories: 3,
      });
      assert.ok(res.body.catalog.activeProducts >= 17);
    });

    test('ST-04 recent orders are bounded, newest first, and use the list summary', async () => {
      const many = Array.from({ length: 25 }, (_, i) => makeOrder({ createdAt: new Date(Date.UTC(2026, 6, 1, 0, i)) }));
      await reset(many);
      const def = await get('/orders/stats');
      assert.equal(def.body.recentOrders.length, 5);
      assert.deepEqual(def.body.recentOrders.map((o) => o._id), many.slice(-5).reverse().map((d) => String(d._id)));
      assert.deepEqual(Object.keys(def.body.recentOrders[0]).sort(), SUMMARY_KEYS);
      assert.equal((await get('/orders/stats?recent=20')).body.recentOrders.length, 20);
      for (const q of ['recent=21', 'recent=0', 'recent=abc', 'recent[]=3']) expectStatus(assert, await get(`/orders/stats?${q}`), 400, q);
    });

    test('ST-05 date range limits order metrics to whole IST days; catalogue counts stay current', async () => {
      await reset([
        makeOrder({ createdAt: new Date('2026-04-01T18:29:00Z'), paymentStatus: 'paid', total: 100 }), // 1 Apr IST
        makeOrder({ createdAt: new Date('2026-04-01T18:31:00Z'), paymentStatus: 'paid', total: 200 }), // 2 Apr IST
        makeOrder({ createdAt: new Date('2026-04-03T10:00:00Z'), paymentStatus: 'pending', total: 50, status: 'cancelled' }), // 3 Apr IST
      ]);
      const res = await get('/orders/stats?from=2026-04-02&to=2026-04-03');
      expectStatus(assert, res, 200);
      assert.deepEqual(res.body.range, { from: '2026-04-02', to: '2026-04-03', timezone: 'Asia/Kolkata' });
      assert.equal(res.body.orders.total, 2);
      assert.equal(res.body.orders.byStatus.cancelled, 1);
      assert.equal(res.body.revenue.paid, 200);
      assert.equal(res.body.revenue.unpaid, 0);
      assert.equal(res.body.recentOrders.length, 2);
      assert.ok(res.body.catalog.totalProducts > 0);
      expectStatus(assert, await get('/orders/stats?from=2026-04-03&to=2026-04-02'), 400);
      expectStatus(assert, await get('/orders/stats?from[$gte]=x'), 400);
    });
  });
});
