// Atomic order numbers (Milestone 5B): counter initialisation from historical data, concurrency,
// restarts, gaps-not-reuse and tracking compatibility. Isolated MongoDB; COD endpoint only.
//
// Two kinds of "process" share the throwaway database here: the API child process (via HTTP) and
// this test process, which imports services/orderNumber.js directly to race initialisations.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

const svc = ctx.skipReason ? null : await import('../../src/services/orderNumber.js');
const { Counter } = ctx.skipReason ? {} : await import('../../src/models/Counter.js');

describe('Atomic order numbers', { skip: ctx.skipReason }, () => {
  let fx;
  const counterValue = async () => (await Counter.findById('orderNumber').lean())?.seq ?? null;
  const place = () => ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.lace._id), quantity: 1 }]);
  const seqOf = (res) => svc.parseOrderNumber(res.body.order.orderNumber);
  const historical = (orderNumber, extra = {}) => ({
    orderNumber,
    user: fx.customer._id,
    customerEmail: 'customer@parisutra.test',
    items: [{ product: fx.lace._id, title: 'Legacy Item', price: 10, quantity: 1 }],
    subtotal: 10, shipping: 0, total: 10,
    ...extra,
  });
  /** Clears orders and the counter, then restarts the API so its once-per-process sync runs again. */
  async function freshStart(orders = [], counter = null) {
    await ctx.models.Order.deleteMany({});
    await Counter.deleteMany({});
    if (orders.length) await ctx.models.Order.insertMany(orders);
    if (counter !== null) await Counter.create({ _id: 'orderNumber', seq: counter });
    await ctx.restartApi();
  }

  before(async () => {
    fx = await ctx.seed();
    await ctx.models.Product.updateOne({ _id: fx.lace._id }, { stock: 100000 });
    await ctx.models.Order.syncIndexes();
  });

  test('ON-01 with no orders and no counter, the first number is AL10001, then AL10002', async () => {
    await freshStart();
    const first = await place();
    expectStatus(assert, first, 201);
    assert.equal(first.body.order.orderNumber, 'AL10001');
    assert.equal((await place()).body.order.orderNumber, 'AL10002');
    assert.equal(await counterValue(), 10002);
  });

  test('ON-02 with historical orders and no counter, numbering continues above the highest one', async () => {
    await freshStart([
      historical('AL20000'), historical('AL19999'), historical('AL9000'),
      historical('T100000'), historical('WEB-77'), // non-standard numbers can never collide; ignored
    ]);
    const res = await place();
    expectStatus(assert, res, 201);
    assert.equal(res.body.order.orderNumber, 'AL20001');
  });

  test('ON-03 an existing counter higher than history is kept (never lowered)', async () => {
    await freshStart([historical('AL20000')], 50000);
    assert.equal((await place()).body.order.orderNumber, 'AL50001');
    assert.equal(await svc.syncCounterFloor(), 50001, 'sync never lowers the counter');
  });

  test('ON-04 an existing counter lower than history is raised at startup', async () => {
    await freshStart([historical('AL30000')], 10)
    const res = await place();
    expectStatus(assert, res, 201);
    assert.equal(res.body.order.orderNumber, 'AL30001');
  });

  test('ON-05 a counter that falls behind while running is repaired; the colliding number is skipped', async () => {
    // State: AL30000, AL30001 exist and the API has already synced. Now the counter is pushed back
    // (as if orders were imported or the counter was edited), so the next $inc yields an existing number.
    const indexes = await ctx.mongoose.connection.db.collection('orders').indexes();
    assert.ok(indexes.some((i) => i.key.orderNumber === 1 && i.unique), 'orderNumber unique index present');
    await ctx.models.Order.insertMany([historical('AL30002'), historical('AL30003')]);
    await Counter.updateOne({ _id: 'orderNumber' }, { seq: 30001 });
    const res = await place();
    expectStatus(assert, res, 201);
    assert.equal(res.body.order.orderNumber, 'AL30004');
    const all = await ctx.models.Order.find().select('orderNumber').lean();
    assert.equal(new Set(all.map((o) => o.orderNumber)).size, all.length, 'no duplicate numbers');
  });

  test('ON-06 many simultaneous first-time initialisations agree on one counter', async () => {
    await ctx.models.Order.deleteMany({});
    await Counter.deleteMany({});
    await ctx.models.Order.insertMany([historical('AL40000')]);
    // 25 racing syncs in this process plus the API's own first sync (fresh process) at the same time.
    await ctx.restartApi();
    const [syncs, apiOrders] = await Promise.all([
      Promise.all(Array.from({ length: 25 }, () => svc.syncCounterFloor())),
      Promise.all(Array.from({ length: 10 }, () => place())),
    ]);
    assert.equal(await Counter.countDocuments(), 1, 'exactly one counter document');
    assert.ok(syncs.every((v) => v >= 40000), `syncs returned ${[...new Set(syncs)]}`);
    assert.deepEqual(apiOrders.map((r) => r.status), Array(10).fill(201));
    const numbers = apiOrders.map(seqOf).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 10 }, (_, i) => 40001 + i), 'consecutive, above history, no duplicates');
  });

  test('ON-07 allocation is atomic: 200 simultaneous allocations from two processes are all distinct', async () => {
    const before = await counterValue();
    const [local, remote] = await Promise.all([
      Promise.all(Array.from({ length: 150 }, () => svc.allocateOrderNumber())),
      Promise.all(Array.from({ length: 50 }, () => place())),
    ]);
    const all = [...local, ...remote.map((r) => r.body.order.orderNumber)];
    assert.equal(new Set(all).size, 200);
    assert.deepEqual(all.map(svc.parseOrderNumber).sort((a, b) => a - b), Array.from({ length: 200 }, (_, i) => before + 1 + i));
  });

  test('ON-08 concurrent checkouts: 5 rounds × 30 simultaneous orders, all succeed with unique numbers', async () => {
    for (let round = 1; round <= 5; round += 1) {
      const results = await Promise.all(Array.from({ length: 30 }, () => place()));
      const statuses = results.map((r) => r.status);
      assert.deepEqual(statuses, Array(30).fill(201), `round ${round}: ${statuses} ${results.map((r) => r.body?.message).filter(Boolean)}`);
      assert.equal(new Set(results.map((r) => r.body.order.orderNumber)).size, 30, `round ${round}`);
    }
    const all = await ctx.models.Order.find().select('orderNumber').lean();
    assert.equal(new Set(all.map((o) => o.orderNumber)).size, all.length);
  });

  test('ON-09 control: the previous count-based generator collides under the same load', async () => {
    // Re-creates the old algorithm (countDocuments() + 1) in this process to show the load above is
    // enough to expose it. Writes go to the throwaway database only.
    const attempts = await Promise.allSettled(Array.from({ length: 30 }, async () => {
      const count = await ctx.models.Order.countDocuments();
      return ctx.models.Order.create(historical(`OLD${10000 + count + 1}`));
    }));
    const failed = attempts.filter((a) => a.status === 'rejected');
    assert.ok(failed.length > 0, 'the old generator should collide at least once');
    assert.ok(failed.every((a) => a.reason?.code === 11000));
    await ctx.models.Order.deleteMany({ orderNumber: /^OLD/ });
  });

  test('ON-10 numbers survive an application restart and are never reused after failures', async () => {
    const before = await place();
    const n = seqOf(before);
    // A failed checkout (insufficient stock) and a number taken but never used (simulated crash
    // between allocation and insert) must not lead to reuse.
    await ctx.models.Product.updateOne({ _id: fx.trim._id }, { stock: 0 });
    expectStatus(assert, await ctx.placeOrder(fx.tokens.customer, [{ productId: String(fx.trim._id), quantity: 1 }]), 400);
    const orphan = await svc.allocateOrderNumber();
    assert.equal(svc.parseOrderNumber(orphan), n + 1);
    await ctx.restartApi();
    const after = await place();
    expectStatus(assert, after, 201);
    assert.equal(seqOf(after), n + 2, 'continues after the gap; the orphaned number is not reused');
    assert.equal(await counterValue(), n + 2);
  });

  test('ON-11 historical and new orders remain trackable; new numbers keep the AL<digits> format', async () => {
    await ctx.models.Order.insertMany([historical('AL10005'), historical('T999')]);
    for (const number of ['AL10005', 'T999']) {
      const res = await ctx.request('GET', `/orders/track?orderNumber=${number}&email=customer@parisutra.test`);
      expectStatus(assert, res, 200, number);
      assert.equal(res.body.order.orderNumber, number);
    }
    const fresh = await place();
    assert.match(fresh.body.order.orderNumber, /^AL[1-9][0-9]*$/);
    const tracked = await ctx.request('GET', `/orders/track?orderNumber=${fresh.body.order.orderNumber.toLowerCase()}&email=customer@parisutra.test`);
    expectStatus(assert, tracked, 200);
  });

  test('ON-12 the read-only audit reports duplicates and non-standard numbers without changing data', async () => {
    // Duplicates can only exist without the unique index; drop it in this throwaway DB to simulate legacy data.
    const orders = ctx.mongoose.connection.db.collection('orders');
    await orders.dropIndex('orderNumber_1');
    await orders.insertMany([
      historical('AL10005'), // duplicate of ON-11's AL10005
      { ...historical('X'), orderNumber: undefined },
    ]);
    const countBefore = await orders.countDocuments();
    const counterBefore = await counterValue();
    const report = await svc.auditOrderNumbers();
    assert.deepEqual(report.duplicates.map((d) => [d.orderNumber, d.count]), [['AL10005', 2]]);
    assert.ok(report.nonStandardCount >= 2);
    assert.ok(report.nonStandardSamples.includes('T999') && report.nonStandardSamples.includes(null));
    assert.equal(report.counter, counterBefore);
    assert.equal(await orders.countDocuments(), countBefore, 'audit is read-only');
    assert.equal(await counterValue(), counterBefore);
  });
});
