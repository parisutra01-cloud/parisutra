// Atomic stock reservation for COD checkout (Milestone 5C). Isolated MongoDB only.
//
// Two layers are exercised:
//  - HTTP: real POST /orders requests against the API child process (many simultaneous requests).
//  - In-process: services/orderService.js createCodOrder() called directly with test-only hooks, to
//    force exact interleavings (barriers, stock changes between steps, failures after reservation)
//    instead of relying on timing.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

const svc = ctx.skipReason ? null : await import('../../src/services/orderService.js');
const ADDRESS = { fullName: 'Test', phone: '9999999999', line1: 'Test line', city: 'Test', state: 'Test', pincode: '400001' };

/** Resolves for everyone once `n` callers have arrived. */
function barrier(n) {
  let arrived = 0;
  let release;
  const all = new Promise((r) => { release = r; });
  return async () => {
    arrived += 1;
    if (arrived === n) release();
    await all;
  };
}

describe('Atomic stock reservation (COD)', { skip: ctx.skipReason }, () => {
  let fx;
  const P = () => ctx.models.Product;
  const stockOf = async (id) => (await P().findById(id)).stock;
  const setStock = (id, stock, extra = {}) => P().updateOne({ _id: id }, { stock, isActive: true, trackStock: true, ...extra });
  const orders = () => ctx.models.Order.countDocuments();
  const lace = () => String(fx.lace._id);
  const trim = () => String(fx.trim._id);
  const http = (items, token = fx.tokens.customer) => ctx.placeOrder(token, items);
  const direct = (items, hooks = {}, extra = {}) => svc.createCodOrder({
    userId: fx.customer._id, items, shippingAddress: ADDRESS, customerName: 'Direct', customerEmail: 'customer@parisutra.test', ...extra,
  }, { hooks });

  before(async () => { fx = await ctx.seed(); });

  test('SR-01 a checkout deducts exactly the ordered quantity', async () => {
    await setStock(fx.lace._id, 10);
    const res = await http([{ productId: lace(), quantity: 3 }]);
    expectStatus(assert, res, 201);
    assert.equal(await stockOf(fx.lace._id), 7);
    assert.equal(res.body.order.items[0].quantity, 3);
    assert.equal(res.body.order.items[0].price, 500, 'price snapshot from the database');
  });

  test('SR-02 insufficient and zero stock are rejected: no order, stock unchanged', async () => {
    await setStock(fx.lace._id, 2);
    const before = await orders();
    const res = await http([{ productId: lace(), quantity: 3 }]);
    expectStatus(assert, res, 400);
    assert.match(res.body.message, /Insufficient stock for Test Gold Lace/);
    await setStock(fx.trim._id, 0);
    const zero = await http([{ productId: trim(), quantity: 1 }]);
    expectStatus(assert, zero, 400);
    assert.match(zero.body.message, /Insufficient stock/);
    assert.equal(await orders(), before);
    assert.equal(await stockOf(fx.lace._id), 2);
    assert.equal(await stockOf(fx.trim._id), 0);
  });

  test('SR-03 deterministic race: two customers both pass the read check for the last unit; only one gets it', async () => {
    await setStock(fx.lace._id, 1);
    const before = await orders();
    const bothRead = barrier(2); // each checkout has already read stock = 1 before reserving
    const results = await Promise.allSettled([
      direct([{ productId: lace(), quantity: 1 }], { beforeReserve: bothRead }),
      direct([{ productId: lace(), quantity: 1 }], { beforeReserve: bothRead }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
    assert.match(results.find((r) => r.status === 'rejected').reason.message, /Insufficient stock/);
    assert.equal(await stockOf(fx.lace._id), 0);
    assert.equal(await orders(), before + 1);
  });

  test('SR-04 deterministic race: 10 checkouts for 4 units after all read the stock', async () => {
    await setStock(fx.lace._id, 4);
    const allRead = barrier(10);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => direct([{ productId: lace(), quantity: 1 }], { beforeReserve: allRead })));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 4);
    assert.equal(await stockOf(fx.lace._id), 0);
  });

  test('SR-05 HTTP: 6 simultaneous checkouts for 2 units, 10 rounds: never negative, exactly 2 orders each', async () => {
    for (let round = 1; round <= 10; round += 1) {
      await setStock(fx.trim._id, 2);
      const before = await orders();
      const results = await Promise.all(Array.from({ length: 6 }, () => http([{ productId: trim(), quantity: 1 }])));
      const ok = results.filter((r) => r.status === 201);
      assert.equal(ok.length, 2, `round ${round}: ${results.map((r) => r.status)}`);
      assert.ok(results.every((r) => r.status === 201 || (r.status === 400 && /Insufficient stock/.test(r.body.message))), `round ${round}`);
      assert.equal(await stockOf(fx.trim._id), 0, `round ${round}`);
      assert.equal(await orders(), before + 2, `round ${round}`);
      assert.equal(new Set(ok.map((r) => r.body.order.orderNumber)).size, 2, 'unique order numbers (5B)');
    }
  });

  test('SR-06 HTTP: 40 simultaneous mixed-quantity checkouts never exceed the stock', async () => {
    await setStock(fx.lace._id, 25);
    const qty = Array.from({ length: 40 }, (_, i) => (i % 3) + 1); // 1,2,3,...
    const results = await Promise.all(qty.map((quantity) => http([{ productId: lace(), quantity }])));
    const sold = results.reduce((sum, r, i) => sum + (r.status === 201 ? qty[i] : 0), 0);
    const stock = await stockOf(fx.lace._id);
    assert.ok(stock >= 0, `stock ${stock}`);
    assert.equal(stock, 25 - sold, 'stock equals initial minus what was actually sold');
    assert.ok(sold <= 25);
  });

  test('SR-07 several products in one cart are all reserved', async () => {
    await setStock(fx.lace._id, 10);
    await setStock(fx.trim._id, 5);
    const res = await http([{ productId: lace(), quantity: 2 }, { productId: trim(), quantity: 3 }]);
    expectStatus(assert, res, 201);
    assert.equal(await stockOf(fx.lace._id), 8);
    assert.equal(await stockOf(fx.trim._id), 2);
  });

  test('SR-08 if the second product cannot be reserved, the first reservation is released and no order exists', async () => {
    await setStock(fx.lace._id, 10);
    await setStock(fx.trim._id, 5);
    const before = await orders();
    // Between the read check and the reservation, another buyer takes the trims.
    await assert.rejects(direct([{ productId: lace(), quantity: 2 }, { productId: trim(), quantity: 3 }], {
      afterReserveLine: async (line) => {
        if (String(line.product) === lace()) {
          assert.equal(await stockOf(fx.lace._id), 8, 'lace reserved first');
          await P().updateOne({ _id: fx.trim._id }, { $inc: { stock: -4 } });
        }
      },
    }), /Insufficient stock for Test Silver Trim/);
    assert.equal(await stockOf(fx.lace._id), 10, 'lace restored');
    assert.equal(await stockOf(fx.trim._id), 1, 'the other buyer keeps their units');
    assert.equal(await orders(), before);
  });

  test('SR-09 if order creation fails after reserving, all stock is restored and the number is not reused', async () => {
    await setStock(fx.lace._id, 10);
    await setStock(fx.trim._id, 5);
    const before = await orders();
    const last = await http([{ productId: lace(), quantity: 1 }]);
    const lastNumber = Number(last.body.order.orderNumber.slice(2));
    // A value Mongoose cannot cast makes Order.create fail after the order number was allocated.
    await assert.rejects(direct([{ productId: lace(), quantity: 2 }, { productId: trim(), quantity: 1 }], {}, { customerEmail: { not: 'a string' } }));
    assert.equal(await stockOf(fx.lace._id), 9);
    assert.equal(await stockOf(fx.trim._id), 5);
    assert.equal(await orders(), before + 1);
    // A failure right before the insert (no number allocated) also restores everything.
    await assert.rejects(direct([{ productId: lace(), quantity: 2 }], { beforeInsert: () => { throw new Error('simulated failure'); } }), /simulated/);
    assert.equal(await stockOf(fx.lace._id), 9);
    const next = await http([{ productId: lace(), quantity: 1 }]);
    assert.ok(Number(next.body.order.orderNumber.slice(2)) > lastNumber + 1, 'the failed insert left a gap, not a reused number');
  });

  test('SR-10 releasing uses $inc, so concurrent stock changes are kept', async () => {
    await setStock(fx.lace._id, 10);
    await setStock(fx.trim._id, 5);
    await assert.rejects(direct([{ productId: lace(), quantity: 2 }, { productId: trim(), quantity: 1 }], {
      afterReserveLine: async (line) => {
        if (String(line.product) !== lace()) return;
        await P().updateOne({ _id: fx.lace._id }, { $inc: { stock: 100 } }); // concurrent restock
        await P().updateOne({ _id: fx.lace._id }, { $inc: { stock: -7 } }); // concurrent sale
        await P().updateOne({ _id: fx.trim._id }, { stock: 0 }); // trims sell out
      },
    }), /Insufficient stock/);
    assert.equal(await stockOf(fx.lace._id), 10 + 100 - 7, 'restock and sale both survive the release');
  });

  test('SR-11 each reservation is released exactly once', async () => {
    await setStock(fx.lace._id, 10);
    await setStock(fx.trim._id, 5);
    await assert.rejects(direct([{ productId: lace(), quantity: 2 }, { productId: trim(), quantity: 3 }], {
      afterReserveLine: (line) => { if (String(line.product) === trim()) throw new Error('fail after both'); },
    }), /fail after both/);
    assert.equal(await stockOf(fx.lace._id), 10);
    assert.equal(await stockOf(fx.trim._id), 5);
    const reservations = [{ productId: fx.lace._id, quantity: 4, released: false }];
    await svc.releaseReservations(reservations);
    await svc.releaseReservations(reservations);
    assert.equal(await stockOf(fx.lace._id), 14, 'second release is a no-op');
  });

  test('SR-12 product rules: untracked stock is not reserved; a product deactivated mid-checkout is refused', async () => {
    await setStock(fx.lace._id, 0, { trackStock: false });
    const res = await http([{ productId: lace(), quantity: 5 }]);
    expectStatus(assert, res, 201);
    assert.equal(await stockOf(fx.lace._id), 0, 'untracked product stock untouched');

    await setStock(fx.lace._id, 10);
    await setStock(fx.trim._id, 5);
    await assert.rejects(direct([{ productId: lace(), quantity: 1 }, { productId: trim(), quantity: 1 }], {
      afterReserveLine: async (line) => { if (String(line.product) === lace()) await P().updateOne({ _id: fx.trim._id }, { isActive: false }); },
    }), /Product unavailable/);
    assert.equal(await stockOf(fx.lace._id), 10);
    assert.equal(await stockOf(fx.trim._id), 5);
    await setStock(fx.trim._id, 5);
  });

  test('SR-13 repeated cart lines reserve the merged quantity (Phase 5A)', async () => {
    await setStock(fx.lace._id, 5);
    expectStatus(assert, await http([{ productId: lace(), quantity: 3 }, { productId: lace(), quantity: 3 }]), 400);
    assert.equal(await stockOf(fx.lace._id), 5);
    const ok = await http([{ productId: lace(), quantity: 2 }, { productId: lace(), quantity: 3 }]);
    expectStatus(assert, ok, 201);
    assert.equal(ok.body.order.items.length, 1);
    assert.equal(await stockOf(fx.lace._id), 0);
  });

  test('SR-14 payment path unchanged: Razorpay endpoints and createOrder behave as before', async () => {
    const config = await ctx.request('GET', '/payments/config');
    expectStatus(assert, config, 200);
    assert.equal(config.body.enabled, false);
    const prepare = await ctx.request('POST', '/payments/razorpay/prepare', { token: fx.tokens.customer, body: { items: [{ productId: lace(), quantity: 1 }], shippingAddress: ADDRESS } });
    expectStatus(assert, prepare, 503);
    // createOrder (used only by Razorpay verification) still deducts after inserting, as before 5C.
    await setStock(fx.lace._id, 10);
    const order = await svc.createOrder({
      userId: fx.customer._id, items: [{ productId: lace(), quantity: 2 }], shippingAddress: ADDRESS,
      paymentMethod: 'razorpay', paymentStatus: 'paid', customerEmail: 'customer@parisutra.test',
    });
    assert.equal(order.paymentStatus, 'paid');
    assert.match(order.orderNumber, /^AL\d+$/);
    assert.equal(await stockOf(fx.lace._id), 8);
  });
});
