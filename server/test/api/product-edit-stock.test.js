// Product edits must not overwrite concurrent stock changes (Phase 5G.3).
// Isolated MongoDB (replica set). "Admin opens the form" = GET /products/manage/:id, exactly what the
// edit form loads; the concurrent change happens next; then the admin saves. Plain races fire the save
// and the competing change simultaneously, repeated over several rounds.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Product edits and concurrent stock changes', { skip: ctx.skipReason }, () => {
  let fx;
  let id;
  const P = () => ctx.models.Product;
  const doc = (pid = id) => P().findById(pid).lean();
  const stock = async (pid = id) => (await doc(pid)).stock;
  const reset = (n, extra = {}) => P().updateOne({ _id: id }, { $set: { stock: n, trackStock: true, isActive: true, title: 'Test Gold Lace', price: 500, ...extra } });
  const put = (body, pid = id, token = fx.tokens.admin) => ctx.request('PUT', `/products/${pid}`, { token, body });
  const openForm = async (pid = id) => (await ctx.request('GET', `/products/manage/${pid}`, { token: fx.tokens.admin })).body.product;
  const buy = (quantity) => ctx.placeOrder(fx.tokens.customer, [{ productId: id, quantity }]);
  const addStock = (quantity) => ctx.request('POST', `/products/${id}/stock/adjust`, { token: fx.tokens.admin, body: { operation: 'add', quantity, reason: 'Delivery' } });
  const cancel = (orderId) => ctx.request('PATCH', `/orders/${orderId}/status`, { token: fx.tokens.admin, body: { status: 'cancelled' } });
  const auditLines = () => ctx.apiStdout().split('\n').filter((l) => l.startsWith('[stock-audit] ')).map((l) => JSON.parse(l.slice('[stock-audit] '.length)));
  /** Everything the edit form sends when stock is untouched (stock is never included). */
  const formPayload = (p, overrides = {}) => ({
    title: p.title, category: String(p.category?._id ?? p.category), unit: p.unit, sku: p.sku ?? '', shortDescription: p.shortDescription ?? '',
    description: p.description ?? '', price: p.price, comparePrice: p.comparePrice ?? '', costPrice: p.costPrice ?? '',
    lowStockAlert: p.lowStockAlert ?? 10, trackStock: p.trackStock !== false, material: p.material ?? [], colors: p.colors ?? [],
    styles: p.styles ?? [], images: (p.images ?? []).map(({ url, isMain }) => ({ url, isMain })), metaTitle: p.metaTitle ?? '',
    metaDescription: p.metaDescription ?? '', isActive: p.isActive !== false, isFeatured: Boolean(p.isFeatured), isNewArrival: Boolean(p.isNewArrival),
    slug: p.slug, ...overrides,
  });
  const strip = ({ updatedAt, __v, ...rest }) => rest; // fields that legitimately change on any write

  before(async () => {
    fx = await ctx.seed();
    id = String(fx.lace._id);
  });

  test('PES-01 editing the title without touching stock leaves stock untouched', async () => {
    await reset(10);
    const p = await openForm();
    await P().updateOne({ _id: id }, { $set: { stock: 7 } }); // any change made while the form is open
    const res = await put(formPayload(p, { title: 'Gold Lace Renamed' }));
    expectStatus(assert, res, 200);
    assert.equal(res.body.product.title, 'Gold Lace Renamed');
    assert.equal(res.body.product.stock, 7, 'response is the authoritative stock');
    assert.equal(await stock(), 7);
  });

  test('PES-02 price, category, descriptions, images, SEO and status edits never write stock', async () => {
    const edits = [
      { price: 650 }, { category: String(fx.trims._id) }, { shortDescription: 'Short', description: 'Long text' },
      { images: [{ url: '/images/lace-a.jpg', isMain: true }, { url: '/images/lace-b.jpg', isMain: false }] },
      { metaTitle: 'SEO title', metaDescription: 'SEO description', slug: 'gold-lace-seo' }, { isActive: false }, { isFeatured: true, lowStockAlert: 4 },
    ];
    for (const edit of edits) {
      await reset(10, { category: fx.laces._id, slug: 'test-gold-lace' });
      const p = await openForm();
      await P().updateOne({ _id: id }, { $inc: { stock: -3 } });
      const res = await put(formPayload(p, edit));
      expectStatus(assert, res, 200, JSON.stringify(edit));
      const after = await doc();
      assert.equal(after.stock, 7, `stock kept for ${JSON.stringify(edit)}`);
      for (const [k, v] of Object.entries(edit)) {
        assert.deepEqual(k === 'category' ? String(after[k]) : k === 'images' ? after[k].map(({ url, isMain }) => ({ url, isMain })) : after[k], v, k);
      }
    }
    await reset(10, { category: fx.laces._id, slug: 'test-gold-lace', images: [], isFeatured: false, lowStockAlert: 10 });
  });

  test('PES-03 a sale while the form is open is kept: 10 − 2 = 8 after an unrelated save', async () => {
    await reset(10);
    const p = await openForm();
    assert.equal(p.stock, 10);
    expectStatus(assert, await buy(2), 201);
    expectStatus(assert, await put(formPayload(p, { price: 525 })), 200);
    assert.equal(await stock(), 8);
    assert.equal((await doc()).price, 525);
  });

  test('PES-04 a cancellation restore while the form is open is kept: 10 + 2 = 12', async () => {
    await reset(12);
    const order = await buy(2);
    expectStatus(assert, order, 201);
    const p = await openForm();
    assert.equal(p.stock, 10);
    expectStatus(assert, await cancel(order.body.order._id), 200);
    assert.equal(await stock(), 12, 'restored');
    expectStatus(assert, await put(formPayload(p, { description: 'Edited during cancellation' })), 200);
    assert.equal(await stock(), 12);
  });

  test('PES-05 another admin adding 5 while the form is open is kept: 15', async () => {
    await reset(10);
    const p = await openForm();
    expectStatus(assert, await addStock(5), 200);
    expectStatus(assert, await put(formPayload(p, { metaTitle: 'Edited' })), 200);
    assert.equal(await stock(), 15);
  });

  test('PES-06 an intentional stock change applies when the database still holds the expected value', async () => {
    await reset(10);
    const p = await openForm();
    const logsBefore = auditLines().length;
    const res = await put(formPayload(p, { title: 'Recounted Lace', stock: 15, expectedStock: 10 }));
    expectStatus(assert, res, 200);
    assert.equal(res.body.product.stock, 15);
    assert.equal(res.body.product.title, 'Recounted Lace', 'other edits applied in the same update');
    assert.equal(await stock(), 15);
    for (let i = 0; i < 40 && auditLines().length === logsBefore; i += 1) await new Promise((r) => setTimeout(r, 25));
    const line = auditLines().at(-1);
    assert.deepEqual([line.operation, line.previousStock, line.newStock, line.actorId, line.productId, line.reason],
      ['product_edit', 10, 15, String(fx.admin._id), id, 'Product edit form']);
  });

  test('PES-07 stale expected stock: 409 with the current stock; nothing in the request is applied', async () => {
    await reset(10);
    const p = await openForm();
    expectStatus(assert, await buy(2), 201);
    const before = await doc();
    const res = await put(formPayload(p, { title: 'Should Not Save', price: 999, stock: 15, expectedStock: 10 }));
    expectStatus(assert, res, 409);
    assert.equal(res.body.code, 'STOCK_CONFLICT');
    assert.equal(res.body.currentStock, 8);
    assert.match(res.body.message, /Stock changed while this form was open \(now 8\)/);
    assert.ok(res.body.errors.stock);
    assert.deepEqual(strip(await doc()), strip(before), 'no partial update');
    assert.equal(await stock(), 8);
  });

  test('PES-08 two admins changing stock from the same expected value: exactly one wins (10 rounds)', async () => {
    for (let round = 0; round < 10; round += 1) {
      await reset(10);
      const p = await openForm();
      const [a, b] = await Promise.all([
        put(formPayload(p, { stock: 20, expectedStock: 10, title: 'Admin A' })),
        put(formPayload(p, { stock: 3, expectedStock: 10, title: 'Admin B' })),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409], `round ${round}`);
      const winner = a.status === 200 ? { stock: 20, title: 'Admin A' } : { stock: 3, title: 'Admin B' };
      const loser = a.status === 200 ? b : a;
      assert.equal(loser.body.currentStock, winner.stock, `round ${round}: loser told the winner's value`);
      const after = await doc();
      assert.deepEqual({ stock: after.stock, title: after.title }, winner, `round ${round}: the loser changed nothing`);
    }
  });

  test('PES-09 a stock value without expectedStock is rejected (no absolute stock path); nothing changes', async () => {
    await reset(10);
    const before = await doc();
    for (const body of [{ stock: 15 }, { stock: 10 }, { stock: 15, title: 'Also Not Saved' }, { stock: 15, expectedStock: undefined }]) {
      const res = await put(body);
      expectStatus(assert, res, 400, JSON.stringify(body));
      assert.ok(res.body.errors.expectedStock, JSON.stringify(body));
    }
    const orphan = await put({ expectedStock: 10, title: 'Not Saved' });
    expectStatus(assert, orphan, 400, 'expectedStock without stock');
    assert.deepEqual(strip(await doc()), strip(before));
  });

  test('PES-10 invalid new stock or expectedStock values are rejected by the product rules; nothing changes', async () => {
    await reset(10);
    const before = await doc();
    const badStock = [-1, 1.5, 'abc', '', null, 10_000_001, { $gt: 0 }, [5], true];
    for (const value of badStock) {
      const res = await put({ title: 'Not Saved', stock: value, expectedStock: 10 });
      expectStatus(assert, res, 400, `stock ${JSON.stringify(value)}`);
      assert.ok(res.body.errors.stock, `stock ${JSON.stringify(value)}`);
    }
    const infinite = await ctx.request('PUT', `/products/${id}`, { token: fx.tokens.admin, rawBody: '{"stock":1e400,"expectedStock":10}', headers: { 'Content-Type': 'application/json' } });
    expectStatus(assert, infinite, 400, 'non-finite stock');
    for (const value of ['10', null, { $ne: 1 }, true, [10]]) {
      const res = await put({ title: 'Not Saved', stock: 15, expectedStock: value });
      expectStatus(assert, res, 400, `expectedStock ${JSON.stringify(value)}`);
      assert.ok(res.body.errors.expectedStock);
    }
    const infiniteExpected = await ctx.request('PUT', `/products/${id}`, { token: fx.tokens.admin, rawBody: '{"stock":5,"expectedStock":-1e400}', headers: { 'Content-Type': 'application/json' } });
    expectStatus(assert, infiniteExpected, 400, 'non-finite expectedStock');
    // Existing product rules still accept a numeric string for stock (as before).
    expectStatus(assert, await put({ stock: '12', expectedStock: 10 }), 200);
    assert.equal(await stock(), 12);
    await reset(10);
    assert.deepEqual(strip({ ...(await doc()), stock: 10 }), strip({ ...before, stock: 10 }));
  });

  test('PES-11 legacy missing/null stock counts as 0, consistent with Phase 5G.2', async () => {
    await P().updateOne({ _id: id }, { $unset: { stock: '' } });
    const p = await openForm();
    expectStatus(assert, await put(formPayload(p, { title: 'Legacy Edit' })), 200);
    assert.equal('stock' in (await doc()), false, 'an unrelated edit does not create a stock value');
    const stale = await put({ stock: 4, expectedStock: 5 });
    expectStatus(assert, stale, 409);
    assert.equal(stale.body.currentStock, 0);
    assert.equal('stock' in (await doc()), false);
    expectStatus(assert, await put({ stock: 4, expectedStock: 0 }), 200, 'missing matches expectedStock 0');
    assert.equal(await stock(), 4);
    await P().updateOne({ _id: id }, { $set: { stock: null } });
    expectStatus(assert, await put({ title: 'Null Edit' }), 200);
    assert.equal(await stock(), null, 'unrelated edit leaves null alone');
    expectStatus(assert, await put({ stock: 6, expectedStock: 0 }), 200, 'null matches expectedStock 0 (like 5G.2 exact count)');
    assert.equal(await stock(), 6);
    await reset(10);
  });

  test('PES-12 product creation still saves its initial stock (expectedStock is not needed)', async () => {
    const res = await ctx.request('POST', '/products', { token: fx.tokens.admin, body: { title: 'New Stocked Lace', price: 120, category: String(fx.laces._id), stock: 25 } });
    expectStatus(assert, res, 201);
    assert.equal(res.body.product.stock, 25);
    assert.equal((await P().findOne({ slug: 'new-stocked-lace' }).lean()).stock, 25);
    const invalid = await ctx.request('POST', '/products', { token: fx.tokens.admin, body: { title: 'Bad Stock Lace', price: 120, category: String(fx.laces._id), stock: -4 } });
    expectStatus(assert, invalid, 400);
  });

  test('PES-13 authorization and existing update validation are unchanged', async () => {
    await reset(10);
    expectStatus(assert, await ctx.request('PUT', `/products/${id}`, { body: { stock: 1, expectedStock: 10 } }), 401);
    expectStatus(assert, await put({ stock: 1, expectedStock: 10 }, id, fx.tokens.customer), 403);
    expectStatus(assert, await put({ price: -1 }), 400);
    expectStatus(assert, await put({ comparePrice: 1 }), 400);
    expectStatus(assert, await put({ sku: 'SKU-2' }), 409);
    expectStatus(assert, await put({ stock: 1, expectedStock: 10 }, String(new ctx.mongoose.Types.ObjectId())), 404);
    expectStatus(assert, await put({ stock: 1, expectedStock: 10 }, 'abc'), 400);
    const mass = await put({ reviewCount: 4242, rating: 1, $set: { stock: 0 }, actorId: 'x' });
    expectStatus(assert, mass, 200, 'unknown fields are ignored as before');
    const after = await doc();
    assert.equal(after.stock, 10);
    assert.notEqual(after.reviewCount, 4242);
  });

  test('PES-14 races: saves never lose a simultaneous sale, cancellation or adjustment (10 rounds each)', async () => {
    for (let round = 0; round < 10; round += 1) {
      // Unrelated edit + sale + admin addition at once: always 10 − 2 + 5.
      await reset(10);
      const p = await openForm();
      const [edit, sale, added] = await Promise.all([put(formPayload(p, { price: 510 + round })), buy(2), addStock(5)]);
      assert.deepEqual([edit.status, sale.status, added.status], [200, 201, 200], `round ${round}`);
      assert.equal(await stock(), 13, `round ${round}: unrelated edit + sale + add`);

      // Intentional change racing a sale: either the edit wins (15 then −2) or it is refused (8).
      await reset(10);
      const q = await openForm();
      const [change, sale2] = await Promise.all([put(formPayload(q, { stock: 15, expectedStock: 10 })), buy(2)]);
      assert.equal(sale2.status, 201);
      if (change.status === 200) assert.equal(await stock(), 13, `round ${round}: edit first, sale kept`);
      else {
        assert.equal(change.status, 409, `round ${round}`);
        assert.equal(await stock(), 8, `round ${round}: sale first, edit refused`);
      }

      // Unrelated edit racing a cancellation restore.
      await reset(12);
      const order = await buy(2);
      const r = await openForm();
      const [edit3, cancelled] = await Promise.all([put(formPayload(r, { description: `round ${round}` })), cancel(order.body.order._id)]);
      assert.deepEqual([edit3.status, cancelled.status], [200, 200]);
      assert.equal(await stock(), 12, `round ${round}: restore kept`);
    }
  });

  test('PES-15 control: the pre-5G.3 save (form stock written back) erases the sale; the new request shapes keep it', async () => {
    await reset(10);
    const p = await openForm();
    expectStatus(assert, await buy(2), 201);
    // What the old PUT did with the old form payload: $set the edited fields AND the stock the form opened with.
    await P().updateOne({ _id: id }, { $set: { price: 530, stock: p.stock } });
    assert.equal(await stock(), 10, 'old behaviour: the sale of 2 was erased (this is what PES-03 detects)');

    await reset(10);
    const q = await openForm();
    expectStatus(assert, await buy(2), 201);
    const oldShape = await put({ ...formPayload(q, { price: 530 }), stock: q.stock });
    expectStatus(assert, oldShape, 400, 'an old client sending stock without expectedStock is refused');
    assert.equal(await stock(), 8);
    expectStatus(assert, await put(formPayload(q, { price: 530 })), 200);
    assert.equal(await stock(), 8, 'new behaviour: the sale is kept');
  });
});
