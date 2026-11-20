// Manual stock operations (Phase 5G.2): atomic add/remove and compare-and-set exact counts.
// Isolated MongoDB (replica set). Deterministic interleavings use the existing test-only hooks of
// createCodOrder / cancelOrder; plain races use many simultaneous HTTP requests, repeated.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

const orderSvc = ctx.skipReason ? null : await import('../../src/services/orderService.js');
const statusSvc = ctx.skipReason ? null : await import('../../src/services/orderStatus.js');
const ADDRESS = { fullName: 'T', phone: '9999999999', line1: 'Line', city: 'C', state: 'S', pincode: '400001' };

describe('Manual stock adjustments', { skip: ctx.skipReason }, () => {
  let fx;
  let id;
  const P = () => ctx.models.Product;
  const stock = async (pid = id) => (await P().findById(pid).lean()).stock;
  const reset = (n, extra = {}) => P().updateOne({ _id: id }, { $set: { stock: n, trackStock: true, isActive: true, ...extra } });
  const adjust = (body, pid = id, token = fx.tokens.admin) => ctx.request('POST', `/products/${pid}/stock/adjust`, { token, body });
  const set = (body, pid = id, token = fx.tokens.admin) => ctx.request('POST', `/products/${pid}/stock/set`, { token, body });
  const add = (quantity, reason = 'Delivery received') => adjust({ operation: 'add', quantity, reason });
  const remove = (quantity, reason = 'Damaged in storage') => adjust({ operation: 'remove', quantity, reason });
  const auditLines = () => ctx.apiStdout().split('\n').filter((l) => l.startsWith('[stock-audit] ')).map((l) => JSON.parse(l.slice('[stock-audit] '.length)));
  const cod = (quantity, hooks) => orderSvc.createCodOrder({
    userId: fx.customer._id, items: [{ productId: id, quantity }], shippingAddress: ADDRESS, customerEmail: 'customer@parisutra.test',
  }, { hooks });
  const waitForLog = async (n) => { for (let i = 0; i < 40 && auditLines().length < n; i += 1) await new Promise((r) => setTimeout(r, 25)); };

  before(async () => {
    fx = await ctx.seed();
    id = String(fx.lace._id);
  });

  test('SA-01 add stock: atomic increment, authoritative result, nothing else changes', async () => {
    await reset(10);
    const before = await P().findById(id).lean();
    const res = await add(5);
    expectStatus(assert, res, 200);
    assert.deepEqual(Object.keys(res.body).sort(), ['change', 'previousStock', 'product']);
    assert.equal(res.body.product.stock, 15);
    assert.equal(res.body.previousStock, 10);
    assert.equal(res.body.change, 5);
    assert.deepEqual(Object.keys(res.body.product).sort(), ['_id', 'isActive', 'lowStockAlert', 'sku', 'stock', 'title', 'trackStock']);
    const after = await P().findById(id).lean();
    assert.equal(after.stock, 15);
    for (const key of ['price', 'title', 'trackStock', 'isActive', 'lowStockAlert', 'sku', 'costPrice']) assert.deepEqual(after[key], before[key], key);
  });

  test('SA-02 remove stock succeeds; removing more than available is refused and changes nothing', async () => {
    await reset(10);
    const ok = await remove(4);
    expectStatus(assert, ok, 200);
    assert.equal(ok.body.product.stock, 6);
    const tooMany = await remove(7);
    expectStatus(assert, tooMany, 409);
    assert.equal(tooMany.body.currentStock, 6);
    assert.match(tooMany.body.message, /only 6 in stock/);
    assert.equal(await stock(), 6);
    expectStatus(assert, await remove(6), 200, 'removing exactly everything is allowed');
    assert.equal(await stock(), 0);
  });

  test('SA-03 simultaneous additions all apply (10 rounds × 20 requests)', async () => {
    for (let round = 0; round < 10; round += 1) {
      await reset(10);
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) => add((i % 3) + 1)));
      assert.ok(results.every((r) => r.status === 200), `round ${round}`);
      const expected = 10 + Array.from({ length: 20 }, (_, i) => (i % 3) + 1).reduce((a, b) => a + b, 0);
      assert.equal(await stock(), expected, `round ${round}`);
    }
  });

  test('SA-04 simultaneous removals never go negative (10 rounds × 12 removals of 1 from 5)', async () => {
    for (let round = 0; round < 10; round += 1) {
      await reset(5);
      const results = await Promise.all(Array.from({ length: 12 }, () => remove(1)));
      assert.equal(results.filter((r) => r.status === 200).length, 5, `round ${round}`);
      assert.ok(results.every((r) => r.status === 200 || r.status === 409));
      assert.equal(await stock(), 0, `round ${round}`);
    }
  });

  test('SA-05 checkout reservation and admin addition both apply (deterministic interleavings)', async () => {
    // Admin adds between the checkout's read check and its reservation.
    await reset(10);
    await cod(2, { beforeReserve: async () => { expectStatus(assert, await add(5), 200); } });
    assert.equal(await stock(), 13);
    // Admin adds after the reservation, before the order is inserted.
    await reset(10);
    await cod(2, { beforeInsert: async () => { expectStatus(assert, await add(5), 200); } });
    assert.equal(await stock(), 13);
    // Many simultaneous checkouts and additions over HTTP.
    for (let round = 0; round < 5; round += 1) {
      await reset(10);
      const results = await Promise.all([
        ...Array.from({ length: 5 }, () => ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 1 }])),
        ...Array.from({ length: 5 }, () => add(2)),
      ]);
      assert.ok(results.every((r) => r.status === 201 || r.status === 200), `round ${round}: ${results.map((r) => r.status)}`);
      assert.equal(await stock(), 10 - 5 + 10, `round ${round}`);
    }
  });

  test('SA-06 checkout reservation and admin removal never oversell', async () => {
    // Admin removes between the checkout's read check (3 available) and its reservation of 2.
    await reset(3);
    await assert.rejects(cod(2, { beforeReserve: async () => { expectStatus(assert, await remove(2), 200); } }), /Insufficient stock/);
    assert.equal(await stock(), 1);
    // Many simultaneous checkouts and removals: stock never negative, every unit accounted for.
    for (let round = 0; round < 10; round += 1) {
      await reset(6);
      const results = await Promise.all([
        ...Array.from({ length: 6 }, () => ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 1 }])),
        ...Array.from({ length: 3 }, () => remove(1)),
      ]);
      const sold = results.slice(0, 6).filter((r) => r.status === 201).length;
      const removed = results.slice(6).filter((r) => r.status === 200).length;
      const final = await stock();
      assert.ok(final >= 0, `round ${round}: stock ${final}`);
      assert.equal(final, 6 - sold - removed, `round ${round}: sold ${sold}, removed ${removed}`);
    }
  });

  test('SA-07 exact count succeeds when the expected stock still matches', async () => {
    await reset(10);
    const res = await set({ quantity: 37, expectedStock: 10, reason: 'Physical recount' });
    expectStatus(assert, res, 200);
    assert.equal(res.body.product.stock, 37);
    assert.equal(res.body.previousStock, 10);
    assert.equal(res.body.change, 27);
    expectStatus(assert, await set({ quantity: 37, expectedStock: 37, reason: 'Recount, unchanged' }), 200);
  });

  test('SA-08 exact count with a stale expected stock returns 409 and the current value; the sale is kept', async () => {
    await reset(10);
    const seen = 10; // admin opens the recount dialog
    expectStatus(assert, await ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 2 }]), 201);
    const res = await set({ quantity: 15, expectedStock: seen, reason: 'Recount' });
    expectStatus(assert, res, 409);
    assert.equal(res.body.currentStock, 8);
    assert.match(res.body.message, /changed since you looked \(now 8\)/);
    assert.equal(await stock(), 8, 'the reservation was not overwritten');
  });

  test('SA-09 two admins with the same expected stock: exactly one wins (10 rounds)', async () => {
    for (let round = 0; round < 10; round += 1) {
      await reset(10);
      const results = await Promise.all([
        set({ quantity: 15, expectedStock: 10, reason: 'Admin A recount' }),
        set({ quantity: 7, expectedStock: 10, reason: 'Admin B recount' }),
      ]);
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [200, 409], `round ${round}`);
      const winner = results.find((r) => r.status === 200).body.product.stock;
      assert.equal(await stock(), winner);
      assert.equal(results.find((r) => r.status === 409).body.currentStock, winner);
    }
  });

  test('SA-10 cancellation restore and admin adjustments both apply', async () => {
    // Deterministic: the admin adds while the cancellation transaction is running (after it read the order).
    await reset(10);
    const placed = await ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 3 }]);
    assert.equal(await stock(), 7);
    let added = false;
    await statusSvc.cancelOrder({
      orderId: placed.body.order._id, actor: 'admin',
      hooks: { afterRead: async () => { if (!added) { added = true; expectStatus(assert, await add(5), 200); } } },
    });
    assert.equal(await stock(), 7 + 5 + 3, 'restore (+3) and addition (+5) both kept');
    // Simultaneous over HTTP, repeated.
    for (let round = 0; round < 5; round += 1) {
      await reset(10);
      const o = await ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 4 }]);
      const results = await Promise.all([
        ctx.request('PATCH', `/orders/${o.body.order._id}/status`, { token: fx.tokens.admin, body: { status: 'cancelled' } }),
        add(2),
        remove(1),
      ]);
      assert.ok(results.every((r) => r.status === 200), `round ${round}: ${results.map((r) => r.status)}`);
      assert.equal(await stock(), 10 - 4 + 4 + 2 - 1, `round ${round}`);
    }
  });

  test('SA-11 untracked products: stock can be adjusted, tracking stays off, checkout unaffected', async () => {
    await reset(0, { trackStock: false });
    const res = await add(3);
    expectStatus(assert, res, 200);
    assert.equal(res.body.product.trackStock, false);
    assert.equal((await P().findById(id).lean()).trackStock, false, 'tracking not silently enabled');
    expectStatus(assert, await ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 10 }]), 201);
    assert.equal(await stock(), 3, 'untracked stock is not reserved');
    expectStatus(assert, await remove(4), 409, 'still never negative');
    expectStatus(assert, await set({ quantity: 50, expectedStock: 3, reason: 'Recount' }), 200);
    assert.equal((await P().findById(id).lean()).trackStock, false);
  });

  test('SA-12 legacy products without a stock value are treated explicitly as 0', async () => {
    const missing = String((await P().collection.insertOne({ title: 'Legacy No Stock', slug: 'legacy-no-stock', category: fx.laces._id, price: 10, isActive: true })).insertedId);
    let res = await adjust({ operation: 'remove', quantity: 1, reason: 'Check' }, missing);
    expectStatus(assert, res, 409);
    assert.equal(res.body.currentStock, 0);
    res = await set({ quantity: 4, expectedStock: 5, reason: 'Recount' }, missing);
    expectStatus(assert, res, 409, 'only an expected value of 0 matches a missing stock value');
    assert.equal((await P().findById(missing).lean()).stock, undefined, 'still untouched');
    res = await adjust({ operation: 'add', quantity: 2, reason: 'First delivery' }, missing);
    expectStatus(assert, res, 200);
    assert.equal(res.body.product.stock, 2);
    assert.equal(res.body.previousStock, 0);

    const legacyNull = String((await P().collection.insertOne({ title: 'Legacy Null Stock', slug: 'legacy-null-stock', category: fx.laces._id, price: 10, stock: null })).insertedId);
    res = await adjust({ operation: 'add', quantity: 2, reason: 'Delivery' }, legacyNull);
    expectStatus(assert, res, 409);
    assert.match(res.body.message, /no recorded stock value/);
    res = await set({ quantity: 6, expectedStock: 0, reason: 'First count' }, legacyNull);
    expectStatus(assert, res, 200);
    assert.equal((await P().findById(legacyNull).lean()).stock, 6);
  });

  test('SA-13 precision: whole units only; legacy fractional/negative values can be corrected by exact count', async () => {
    await reset(10);
    for (const quantity of [1.5, 0.1, 2.000001]) {
      expectStatus(assert, await add(quantity), 400, `add ${quantity}`);
      expectStatus(assert, await set({ quantity, expectedStock: 10, reason: 'x' }), 400, `set ${quantity}`);
    }
    assert.equal(await stock(), 10);
    await reset(2.5);
    expectStatus(assert, await set({ quantity: 3, expectedStock: 2.5, reason: 'Fix fractional legacy value' }), 200);
    await reset(-1);
    expectStatus(assert, await remove(1), 409, 'negative legacy stock cannot be reduced further');
    expectStatus(assert, await set({ quantity: 0, expectedStock: -1, reason: 'Fix negative stock' }), 200);
    assert.equal(await stock(), 0);
  });

  test('SA-14 authorization and input validation; failed requests never change stock', async () => {
    await reset(10);
    const valid = { operation: 'add', quantity: 1, reason: 'x' };
    expectStatus(assert, await ctx.request('POST', `/products/${id}/stock/adjust`, { body: valid }), 401);
    expectStatus(assert, await adjust(valid, id, fx.tokens.customer), 403);
    expectStatus(assert, await ctx.request('POST', `/products/${id}/stock/set`, { body: { quantity: 1, expectedStock: 10, reason: 'x' } }), 401);
    expectStatus(assert, await set({ quantity: 1, expectedStock: 10, reason: 'x' }, id, fx.tokens.customer), 403);

    const badAdjust = [
      {}, [], { operation: 'add', quantity: 1 }, { operation: 'add', quantity: 1, reason: '   ' }, { operation: 'add', quantity: 1, reason: 5 },
      { operation: 'add', quantity: 1, reason: 'x'.repeat(201) }, { operation: 'increase', quantity: 1, reason: 'x' },
      { operation: 'add', quantity: 0, reason: 'x' }, { operation: 'add', quantity: -3, reason: 'x' }, { operation: 'add', quantity: '5', reason: 'x' },
      { operation: 'add', quantity: 10_000_001, reason: 'x' }, { operation: 'add', quantity: { $gt: 0 }, reason: 'x' },
      { operation: { $ne: 'x' }, quantity: 1, reason: 'x' }, { operation: 'add', quantity: 1, reason: 'x', actorId: 'someone' },
      { operation: 'add', quantity: 1, reason: 'x', $set: { price: 1 } }, { operation: 'add', quantity: 1, reason: 'x', stock: 999 },
    ];
    for (const body of badAdjust) {
      const res = await adjust(body);
      expectStatus(assert, res, 400, JSON.stringify(body));
      assert.equal(typeof res.body.message, 'string');
    }
    const badSet = [
      { quantity: 5, reason: 'x' }, { quantity: 5, expectedStock: '10', reason: 'x' }, { quantity: -1, expectedStock: 10, reason: 'x' },
      { quantity: 5, expectedStock: 10 }, { quantity: 5, expectedStock: { $gte: 0 }, reason: 'x' }, { quantity: 5, expectedStock: 10, reason: 'x', force: true },
    ];
    for (const body of badSet) expectStatus(assert, await set(body), 400, JSON.stringify(body));
    // NaN / Infinity are not valid JSON numbers; a raw body proves they are rejected too.
    const raw = await fetch(`${ctx.base}/products/${id}/stock/adjust`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${fx.tokens.admin}` },
      body: '{"operation":"add","quantity":"NaN","reason":"x"}',
    });
    assert.equal(raw.status, 400);
    expectStatus(assert, await adjust(valid, 'not-an-id'), 400);
    expectStatus(assert, await adjust(valid, String(new ctx.mongoose.Types.ObjectId())), 404);
    expectStatus(assert, await set({ quantity: 1, expectedStock: 0, reason: 'x' }, String(new ctx.mongoose.Types.ObjectId())), 404);
    assert.equal(await stock(), 10, 'no failed request changed stock');
  });

  test('SA-15 each successful change writes one structured audit line without personal data', async () => {
    await reset(10);
    const before = auditLines().length;
    await add(5, 'Delivery from Surat');
    await set({ quantity: 12, expectedStock: 15, reason: 'Recount after audit' });
    await remove(100); // refused: no line
    await waitForLog(before + 2);
    const lines = auditLines().slice(before);
    assert.equal(lines.length, 2);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['actorId', 'at', 'event', 'newStock', 'operation', 'previousStock', 'productId', 'quantity', 'reason']);
    assert.deepEqual(
      lines.map((l) => [l.event, l.actorId, l.productId, l.operation, l.previousStock, l.newStock, l.reason]),
      [
        ['stock.manual_change', String(fx.admin._id), id, 'add', 10, 15, 'Delivery from Surat'],
        ['stock.manual_change', String(fx.admin._id), id, 'set', 15, 12, 'Recount after audit'],
      ],
    );
    assert.ok(!Number.isNaN(Date.parse(lines[0].at)));
    const text = JSON.stringify(lines);
    for (const secret of ['@', 'Bearer', fx.tokens.admin, 'password']) assert.ok(!text.includes(secret), secret);
  });

  test('SA-16 control: the old absolute product update loses changes that the new operations keep', async () => {
    // Two admins both see 10: A receives 5 units, B finds 3 damaged. Intended result: 12.
    await reset(10);
    await ctx.request('PUT', `/products/${id}`, { token: fx.tokens.admin, body: { stock: 15 } });
    await ctx.request('PUT', `/products/${id}`, { token: fx.tokens.admin, body: { stock: 7 } });
    assert.equal(await stock(), 7, 'absolute update: A\'s delivery is lost');
    await reset(10);
    await add(5);
    await remove(3);
    assert.equal(await stock(), 12, 'adjustments: both kept');
    // A sale while the admin is looking: the absolute update erases it, compare-and-set refuses.
    await reset(10);
    await ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 2 }]);
    await ctx.request('PUT', `/products/${id}`, { token: fx.tokens.admin, body: { stock: 10 } });
    assert.equal(await stock(), 10, 'absolute update: the sale was erased');
    await reset(10);
    await ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity: 2 }]);
    expectStatus(assert, await set({ quantity: 10, expectedStock: 10, reason: 'Stale recount' }), 409);
    assert.equal(await stock(), 8, 'compare-and-set: the sale is kept');
  });
});
