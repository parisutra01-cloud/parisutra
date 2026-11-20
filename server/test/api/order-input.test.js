// Order input safety (Milestone 5A): cart validation, duplicate-line merging, status filters,
// tracking privacy and customer email. Isolated MongoDB; COD endpoint only (Razorpay never called).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

const ADDRESS = { fullName: 'Test', phone: '9999999999', line1: 'Test line', city: 'Test', state: 'Test', pincode: '400001' };

describe('Order input safety', { skip: ctx.skipReason }, () => {
  let fx;
  const stockOf = async (id) => (await ctx.models.Product.findById(id)).stock;
  const setStock = (id, stock) => ctx.models.Product.updateOne({ _id: id }, { stock });
  const order = (body, token = fx.tokens.customer) => ctx.request('POST', '/orders', { token, body: { shippingAddress: ADDRESS, ...body } });
  const lace = () => String(fx.lace._id);
  /** A rejected order must not create anything or touch stock. */
  async function expectRejected(body, pattern, note) {
    const [orders, stock] = [await ctx.models.Order.countDocuments(), await stockOf(fx.lace._id)];
    const res = await order(body);
    expectStatus(assert, res, 400, note);
    assert.equal(typeof res.body.message, 'string', `${note}: JSON message`);
    if (pattern) assert.match(res.body.message, pattern, note);
    assert.doesNotMatch(res.body.message, /Cannot read|undefined|TypeError|Cast to|E11000|ObjectId failed/, `${note}: raw error leaked`);
    assert.equal(await ctx.models.Order.countDocuments(), orders, `${note}: no order created`);
    assert.equal(await stockOf(fx.lace._id), stock, `${note}: stock untouched`);
    return res;
  }

  before(async () => {
    fx = await ctx.seed();
    await setStock(fx.lace._id, 50);
  });

  test('OIS-01 invalid quantities are rejected (negative, zero, decimal, string, NaN, null, missing, too large)', async () => {
    const cases = [-5, 0, 1.5, '2', 'abc', null, undefined, true, 1001, 1e9];
    for (const quantity of cases) {
      await expectRejected({ items: [{ productId: lace(), quantity }] }, /quantity/, `quantity ${JSON.stringify(quantity)}`);
    }
    // NaN / Infinity cannot be expressed in JSON; a raw body proves non-numbers never become 1.
    const raw = await fetch(`${ctx.base}/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.tokens.customer}` },
      body: `{"items":[{"productId":"${lace()}","quantity":"NaN"}],"shippingAddress":${JSON.stringify(ADDRESS)}}`,
    });
    assert.equal(raw.status, 400);
  });

  test('OIS-02 cart structure: empty, non-array, null lines, arrays, invalid and operator product ids', async () => {
    await expectRejected({ items: [] }, /empty/, 'empty cart');
    await expectRejected({ items: 'abc' }, /list/, 'string cart');
    await expectRejected({ items: { 0: { productId: lace(), quantity: 1 } } }, /list/, 'object cart');
    await expectRejected({}, /list/, 'missing cart');
    await expectRejected({ items: [null] }, /object/, 'null line');
    await expectRejected({ items: [[lace(), 1]] }, /object/, 'array line');
    await expectRejected({ items: [{ productId: 'not-an-id', quantity: 1 }] }, /product id/, 'malformed id');
    await expectRejected({ items: [{ productId: 123456, quantity: 1 }] }, /product id/, 'numeric id');
    await expectRejected({ items: [{ productId: { $ne: null }, quantity: 1 }] }, undefined, 'operator id');
    await expectRejected({ items: [{ productId: { $gt: '' }, quantity: 1 }] }, undefined, 'operator id 2');
    await expectRejected({ items: [{ productId: lace(), quantity: 1, meta: { nested: true } }] }, /nested/, 'nested field');
  });

  test('OIS-03 product variations are rejected explicitly', async () => {
    const res = await expectRejected({ items: [{ productId: lace(), quantity: 1, variationId: String(fx.trim._id), variationLabel: 'Red' }] }, /variations/, 'variation');
    assert.ok(Object.keys(res.body.errors).some((k) => k.endsWith('variationId')));
  });

  test('OIS-04 too many cart lines are rejected', async () => {
    const items = Array.from({ length: 51 }, (_, i) => ({ productId: i.toString(16).padStart(24, 'a'), quantity: 1 }));
    await expectRejected({ items }, /at most 50/, '51 products');
  });

  test('OIS-05 repeated lines for one product are merged into a single order line', async () => {
    await setStock(fx.lace._id, 50);
    const res = await order({ items: [{ productId: lace(), quantity: 2 }, { productId: String(fx.trim._id), quantity: 1 }, { productId: lace(), quantity: 3 }] });
    expectStatus(assert, res, 201);
    assert.deepEqual(res.body.order.items.map((i) => [i.product, i.quantity]), [[lace(), 5], [String(fx.trim._id), 1]]);
    assert.equal(res.body.order.subtotal, 5 * 500 + 1200);
    assert.equal(await stockOf(fx.lace._id), 45);
  });

  test('OIS-06 repeated lines cannot bypass the stock check', async () => {
    await setStock(fx.lace._id, 3);
    const res = await expectRejected({ items: [{ productId: lace(), quantity: 2 }, { productId: lace(), quantity: 2 }] }, /Insufficient stock/, 'split lines');
    assert.ok(res);
    assert.equal(await stockOf(fx.lace._id), 3, 'stock never negative');
    await setStock(fx.lace._id, 50);
  });

  test('OIS-07 the customer email comes from the account, normalised; body email is ignored', async () => {
    const res = await order({ items: [{ productId: lace(), quantity: 1 }], customerEmail: 'VICTIM@Example.com' });
    expectStatus(assert, res, 201);
    assert.equal(res.body.order.customerEmail, 'customer@parisutra.test');
    const stored = await ctx.models.Order.findById(res.body.order._id).lean();
    assert.equal(stored.customerEmail, 'customer@parisutra.test');
    // Tracking with the spoofed email finds nothing.
    expectStatus(assert, await ctx.request('GET', `/orders/track?orderNumber=${stored.orderNumber}&email=victim@example.com`), 404);
  });

  test('OIS-08 customer name/phone must be plain short text; address fields must be text', async () => {
    await expectRejected({ items: [{ productId: lace(), quantity: 1 }], customerName: { $gt: '' } }, /customerName/, 'object name');
    await expectRejected({ items: [{ productId: lace(), quantity: 1 }], customerPhone: 'x'.repeat(31) }, /customerPhone/, 'long phone');
    await expectRejected({ items: [{ productId: lace(), quantity: 1 }], shippingAddress: { line1: { $ne: 1 }, pincode: '1' } }, /line1/, 'object address field');
    await expectRejected({ items: [{ productId: lace(), quantity: 1 }], shippingAddress: 'Somewhere' }, /address/, 'string address');
  });

  test('OIS-09 status filters accept only known plain values (admin and customer lists)', async () => {
    const admin = (q) => ctx.request('GET', `/orders${q}`, { token: fx.tokens.admin });
    const mine = (q) => ctx.request('GET', `/orders/my${q}`, { token: fx.tokens.customer });
    for (const get of [admin, mine]) {
      for (const q of ['?status=teleported', '?status=PENDING', '?status[$ne]=cancelled', '?status[$in][]=pending', '?status=pending&status=shipped']) {
        const res = await get(q);
        expectStatus(assert, res, 400, q);
        assert.match(res.body.message, /Invalid status/);
      }
      const ok = await get('?status=pending');
      expectStatus(assert, ok, 200);
      assert.ok(ok.body.orders.length >= 1 && ok.body.orders.every((o) => o.status === 'pending'));
      expectStatus(assert, await get('?status='), 200, 'empty filter = all');
    }
    // Authorization unchanged.
    expectStatus(assert, await ctx.request('GET', '/orders?status=pending', { token: fx.tokens.customer }), 403);
    expectStatus(assert, await ctx.request('GET', '/orders/my?status=pending'), 401);
  });

  test('OIS-10 public tracking returns only the allowlisted view', async () => {
    const placed = await order({ items: [{ productId: lace(), quantity: 2 }] });
    const number = placed.body.order.orderNumber;
    const res = await ctx.request('GET', `/orders/track?orderNumber=${number}&email=customer@parisutra.test`);
    expectStatus(assert, res, 200);
    assert.deepEqual(Object.keys(res.body.order).sort(), ['createdAt', 'itemCount', 'items', 'orderNumber', 'status', 'total', 'updatedAt']);
    assert.deepEqual(res.body.order.items, [{ title: 'Test Gold Lace', quantity: 2, unit: 'meter', image: placed.body.order.items[0].image }].map((i) => JSON.parse(JSON.stringify(i))));
    const json = JSON.stringify(res.body);
    for (const secret of ['9999999999', 'Test line', '400001', 'customer@parisutra.test', String(fx.customer._id), placed.body.order._id, 'paymentStatus', 'razorpay']) {
      assert.ok(!json.includes(secret), `tracking leaks ${secret}`);
    }
  });

  test('OIS-11 tracking input is validated and normalised', async () => {
    const placed = await order({ items: [{ productId: lace(), quantity: 1 }] });
    const number = placed.body.order.orderNumber;
    expectStatus(assert, await ctx.request('GET', `/orders/track?orderNumber=${number.toLowerCase()}&email=%20Customer@PARISUTRA.test%20`), 200, 'normalised');
    expectStatus(assert, await ctx.request('GET', `/orders/track?orderNumber[$ne]=x&email[$ne]=y`), 400, 'operators');
    expectStatus(assert, await ctx.request('GET', `/orders/track?orderNumber=${number}&orderNumber=AL1&email=customer@parisutra.test`), 400, 'array');
    expectStatus(assert, await ctx.request('GET', `/orders/track?orderNumber=${number}&email=not-an-email`), 400, 'bad email');
    expectStatus(assert, await ctx.request('GET', `/orders/track?orderNumber=${number}&email=.*`), 400, 'regex email');
    expectStatus(assert, await ctx.request('GET', `/orders/track?orderNumber=${number}&email=customer%40parisutra.tes`), 404, 'near-miss email');
  });

  test('OIS-12 a valid checkout still works end to end and ownership is unchanged', async () => {
    await setStock(fx.trim._id, 5);
    const res = await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.trim._id), quantity: 1 }]);
    expectStatus(assert, res, 201);
    assert.equal(res.body.order.total, 1200);
    assert.equal(res.body.order.customerName, 'Test Customer');
    assert.equal(await stockOf(fx.trim._id), 4);
    // Another customer can neither read nor cancel it.
    const other = await ctx.models.User.create({ name: 'Other', email: 'other@parisutra.test', password: 'OtherPass123', role: 'customer' });
    const token = await ctx.login('other@parisutra.test', 'OtherPass123');
    assert.ok(other && token);
    expectStatus(assert, await ctx.request('GET', `/orders/my/${res.body.order._id}`, { token }), 404);
    expectStatus(assert, await ctx.request('PATCH', `/orders/my/${res.body.order._id}/cancel`, { token }), 404);
    assert.ok(!(await ctx.request('GET', '/orders/my', { token })).body.orders.some((o) => o._id === res.body.order._id));
  });

  test('OIS-13 an order from a deleted account is refused (no orphan orders)', async () => {
    const ghost = await ctx.models.User.create({ name: 'Ghost', email: 'ghost@parisutra.test', password: 'GhostPass123', role: 'customer' });
    const token = await ctx.login('ghost@parisutra.test', 'GhostPass123');
    await ctx.models.User.deleteOne({ _id: ghost._id });
    const res = await order({ items: [{ productId: lace(), quantity: 1 }] }, token);
    expectStatus(assert, res, 401);
    assert.equal(await ctx.models.Order.countDocuments({ user: ghost._id }), 0);
  });
});
