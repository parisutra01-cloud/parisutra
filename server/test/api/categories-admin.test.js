// Category management (Milestone 4): admin listing, create/edit, slug history, deactivate/restore,
// guarded delete, product relationships, storefront visibility and category images.
// Isolated MongoDB; Cloudinary is a LOCAL mock (no request reaches Cloudinary).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';
import { startCloudinaryMock } from '../helpers/cloudinaryMock.js';

const cloudinary = await startCloudinaryMock();
const ctx = await createTestContext(import.meta.url, { extraEnv: cloudinary.env });
after(async () => { await ctx.close(); await cloudinary.close(); });

describe('Category management', { skip: ctx.skipReason }, () => {
  let fx;
  const admin = (method, path, body) => ctx.request(method, path, { token: fx.tokens.admin, body });
  const create = async (body) => {
    const res = await admin('POST', '/categories', body);
    expectStatus(assert, res, 201, `fixture category ${JSON.stringify(body)}`);
    return res.body.category;
  };
  const addProduct = async (category, extra = {}) => {
    const res = await admin('POST', '/products', { title: `P ${Math.random().toString(36).slice(2, 8)}`, price: 50, category: String(category._id), ...extra });
    expectStatus(assert, res, 201, 'fixture product');
    return res.body.product;
  };
  const manage = (query = '') => admin('GET', `/categories/manage${query}`);
  const row = (res, id) => res.body.categories.find((c) => c._id === String(id));

  before(async () => { fx = await ctx.seed(); });

  test('CM-01 admin listing returns every category with product counts, sub-category counts and stats', async () => {
    await ctx.models.Product.create({ title: 'Inactive Lace', slug: 'inactive-lace', price: 5, category: fx.laces._id, isActive: false });
    const res = await manage();
    expectStatus(assert, res, 200);
    const laces = row(res, fx.laces._id);
    assert.equal(laces.productCount, 2, 'counts active and inactive products');
    assert.equal(laces.activeProductCount, 1);
    assert.equal(laces.childCount, 0);
    assert.equal(row(res, fx.trims._id).productCount, 1);
    assert.equal(res.body.stats.total, res.body.categories.length);
    assert.equal(res.body.stats.products, 3);
    assert.deepEqual(res.body.categories.map((c) => c.name), ['Laces', 'Trims'], 'default sort is display order');
    assert.deepEqual(res.body.pagination, { page: 1, limit: 2, total: 2, pages: 1 });
  });

  test('CM-02 search (name, slug, description) and status filter; bad filter values → 400', async () => {
    await create({ name: 'Zari Borders', slug: 'zari-edge', description: 'Metallic thread work', isActive: false });
    assert.deepEqual((await manage('?q=zari')).body.categories.map((c) => c.name), ['Zari Borders']);
    assert.deepEqual((await manage('?q=zari-edge')).body.categories.map((c) => c.name), ['Zari Borders']);
    assert.deepEqual((await manage('?q=metallic')).body.categories.map((c) => c.name), ['Zari Borders']);
    assert.deepEqual((await manage('?q=.*')).body.categories, [], 'search input is matched literally');
    assert.deepEqual((await manage('?status=inactive')).body.categories.map((c) => c.name), ['Zari Borders']);
    assert.ok((await manage('?status=active')).body.categories.every((c) => c.isActive !== false));
    const stats = (await manage('?status=inactive')).body.stats;
    assert.equal(stats.inactive, 1);
    assert.equal(stats.total, 3, 'stats cover all categories, not just the filtered page');
    expectStatus(assert, await manage('?status=bogus'), 400);
    expectStatus(assert, await manage('?sort=bogus'), 400);
    expectStatus(assert, await manage('?status[$ne]=x'), 400);
  });

  test('CM-03 sorting and pagination', async () => {
    const byName = (await manage('?sort=name-desc')).body.categories.map((c) => c.name);
    assert.deepEqual(byName, [...byName].sort().reverse());
    assert.equal((await manage('?sort=products-desc')).body.categories[0].name, 'Laces');
    const p1 = await manage('?sort=name-asc&limit=2&page=1');
    const p2 = await manage('?sort=name-asc&limit=2&page=2');
    assert.equal(p1.body.categories.length, 2);
    assert.equal(p2.body.categories.length, 1);
    assert.deepEqual(p2.body.pagination, { page: 2, limit: 2, total: 3, pages: 2 });
    assert.equal((await manage('?limit=2&page=99')).body.pagination.page, 2, 'page is clamped');
  });

  test('CM-04 create with every supported field persists; detail endpoint returns usage', async () => {
    const made = await create({
      name: 'Gota Patti', slug: 'gota-work', description: '  Traditional ribbon work  ',
      image: '/images/product-8.jpg', sortOrder: 7, isActive: true, parent: String(fx.laces._id),
    });
    assert.equal(made.slug, 'gota-work');
    assert.equal(made.description, 'Traditional ribbon work');
    assert.equal(made.sortOrder, 7);
    assert.equal(String(made.parent), String(fx.laces._id));
    const detail = await admin('GET', `/categories/manage/${made._id}`);
    expectStatus(assert, detail, 200);
    assert.equal(detail.body.category.parent.name, 'Laces');
    assert.deepEqual(detail.body.usage, { products: 0, activeProducts: 0, media: 0, children: 0 });
    const listed = row(await manage(), fx.laces._id);
    assert.equal(listed.childCount, 1);
    assert.equal(row(await manage(), made._id).parentName, 'Laces');
    // Persisted in the database, not just echoed back.
    const stored = await ctx.models.Category.findById(made._id).lean();
    assert.equal(stored.image, '/images/product-8.jpg');
  });

  test('CM-05 invalid input types and values → 400 with per-field errors; nothing created', async () => {
    const before = await ctx.models.Category.countDocuments();
    const cases = [
      [{ name: 42 }, 'name'],
      [{ name: ['Laces'] }, 'name'],
      [{ name: 'Valid Name', slug: '!!!' }, 'slug'],
      [{ name: 'Valid Name', slug: { $ne: 1 } }, 'slug'],
      [{ name: 'Valid Name', description: 'x'.repeat(1001) }, 'description'],
      [{ name: 'Valid Name', description: { a: 1 } }, 'description'],
      [{ name: 'Valid Name', sortOrder: -1 }, 'sortOrder'],
      [{ name: 'Valid Name', sortOrder: 1.5 }, 'sortOrder'],
      [{ name: 'Valid Name', sortOrder: 'abc' }, 'sortOrder'],
      [{ name: 'Valid Name', isActive: 'yes' }, 'isActive'],
      [{ name: 'Valid Name', parent: 'not-an-id' }, 'parent'],
      [{ name: 'Valid Name', parent: String(new ctx.mongoose.Types.ObjectId()) }, 'parent'],
      [{ name: 'Valid Name', image: 'https://evil.example/x.jpg' }, 'image'],
      [{ name: 'Valid Name', image: 'https://res.cloudinary.com/another-cloud/image/upload/x.png' }, 'image'],
      [{ name: 'Valid Name', image: 'javascript:alert(1)' }, 'image'],
      [{ name: 'Valid Name', image: '/images/../../etc/passwd' }, 'image'],
    ];
    for (const [body, field] of cases) {
      const res = await admin('POST', '/categories', body);
      expectStatus(assert, res, 400, JSON.stringify(body));
      assert.ok(res.body.errors?.[field], `errors.${field} expected for ${JSON.stringify(body)}`);
    }
    assert.equal(await ctx.models.Category.countDocuments(), before);
  });

  test('CM-06 duplicate names (any case/spacing) and duplicate slugs → 409 with the field', async () => {
    const dupName = await admin('POST', '/categories', { name: '  LACES ', slug: 'other-laces' });
    expectStatus(assert, dupName, 409);
    assert.ok(dupName.body.errors?.name);
    const dupSlug = await admin('POST', '/categories', { name: 'Fresh Name', slug: 'trims' });
    expectStatus(assert, dupSlug, 409);
    assert.ok(dupSlug.body.errors?.slug);
    const renameClash = await admin('PATCH', `/categories/${fx.trims._id}`, { name: 'laces' });
    expectStatus(assert, renameClash, 409);
    const slugClash = await admin('PATCH', `/categories/${fx.trims._id}`, { slug: 'laces' });
    expectStatus(assert, slugClash, 409);
    assert.equal((await ctx.models.Category.findById(fx.trims._id)).slug, 'trims');
  });

  test('CM-07 server-controlled fields cannot be mass-assigned', async () => {
    const id = new ctx.mongoose.Types.ObjectId();
    const made = await create({ name: 'Mass Assign', _id: String(id), previousSlugs: ['laces-x'], createdAt: '2001-01-01T00:00:00.000Z' });
    assert.notEqual(made._id, String(id));
    assert.deepEqual(made.previousSlugs, []);
    assert.notEqual(new Date(made.createdAt).getUTCFullYear(), 2001);
  });

  test('CM-08 rename keeps product references and the old storefront URL', async () => {
    const cat = await create({ name: 'Borders Old' });
    const product = await addProduct(cat);
    const res = await admin('PATCH', `/categories/${cat._id}`, { name: 'Borders New' });
    expectStatus(assert, res, 200);
    assert.equal(res.body.category.slug, 'borders-new');
    assert.deepEqual(res.body.category.previousSlugs, ['borders-old']);
    assert.equal(String((await ctx.models.Product.findById(product._id)).category), cat._id, 'product reference unchanged');
    // Storefront: both the new and the old slug resolve to the same category and its products.
    for (const slug of ['borders-new', 'borders-old']) {
      const page = await ctx.request('GET', `/categories/${slug}`);
      expectStatus(assert, page, 200, slug);
      assert.equal(page.body.category._id, cat._id);
      const list = await ctx.request('GET', `/products?categorySlug=${slug}`);
      assert.deepEqual(list.body.products.map((p) => p._id), [product._id], slug);
    }
    const adminView = await admin('GET', `/products/manage/${product._id}`);
    assert.equal(adminView.body.product.category.name, 'Borders New');
  });

  test('CM-09 an old slug stays reserved for its category; the category itself may take it back', async () => {
    const taken = await admin('POST', '/categories', { name: 'Someone Else', slug: 'borders-old' });
    expectStatus(assert, taken, 409);
    assert.ok(taken.body.errors?.slug);
    const cat = await ctx.models.Category.findOne({ slug: 'borders-new' });
    const back = await admin('PATCH', `/categories/${cat._id}`, { slug: 'borders-old' });
    expectStatus(assert, back, 200);
    assert.equal(back.body.category.slug, 'borders-old');
    assert.deepEqual(back.body.category.previousSlugs, ['borders-new']);
  });

  test('CM-10 explicit slug edits; renaming with the current slug sent keeps the slug', async () => {
    const cat = await create({ name: 'Tassel Craft' });
    const keep = await admin('PATCH', `/categories/${cat._id}`, { name: 'Tassel Crafts', slug: 'tassel-craft' });
    expectStatus(assert, keep, 200);
    assert.equal(keep.body.category.slug, 'tassel-craft');
    assert.deepEqual(keep.body.category.previousSlugs, []);
    const changed = await admin('PATCH', `/categories/${cat._id}`, { slug: 'Tassels & More' });
    expectStatus(assert, changed, 200);
    assert.equal(changed.body.category.slug, 'tassels-more', 'slug is normalised');
    assert.equal((await ctx.request('GET', '/categories/tassel-craft')).status, 200);
    const partial = await admin('PATCH', `/categories/${cat._id}`, { description: 'Only this' });
    expectStatus(assert, partial, 200);
    assert.equal(partial.body.category.name, 'Tassel Crafts', 'partial update leaves other fields');
  });

  test('CM-11 deactivate hides the category from the storefront without modifying its products; restore brings it back', async () => {
    const cat = await create({ name: 'Seasonal' });
    const product = await addProduct(cat);
    const before = await ctx.models.Product.findById(product._id).lean();

    const off = await admin('PATCH', `/categories/${cat._id}`, { isActive: false });
    expectStatus(assert, off, 200);
    assert.equal(off.body.category.isActive, false);
    assert.deepEqual(off.body.usage, { products: 1, activeProducts: 1, media: 0, children: 0 });

    const after = await ctx.models.Product.findById(product._id).lean();
    assert.equal(after.isActive, true, 'product status untouched');
    assert.equal(String(after.category), cat._id, 'product category untouched');
    assert.equal(String(after.updatedAt), String(before.updatedAt), 'product document not written');

    assert.ok(!(await ctx.request('GET', '/categories')).body.categories.some((c) => c._id === cat._id));
    expectStatus(assert, await ctx.request('GET', '/categories/seasonal'), 404);
    assert.deepEqual((await ctx.request('GET', '/products?categorySlug=seasonal')).body.products, []);
    expectStatus(assert, await ctx.request('GET', `/products/${product._id}`), 200, 'product page still works');
    assert.equal(row(await manage(), cat._id).isActive, false, 'still manageable by admins');

    const on = await admin('PATCH', `/categories/${cat._id}`, { isActive: true });
    expectStatus(assert, on, 200);
    expectStatus(assert, await ctx.request('GET', '/categories/seasonal'), 200);
    assert.equal((await ctx.request('GET', '/products?categorySlug=seasonal')).body.products.length, 1);
  });

  test('CM-12 inactive categories cannot receive products; products already in one stay editable', async () => {
    const cat = await create({ name: 'Retired' });
    const product = await addProduct(cat);
    await admin('PATCH', `/categories/${cat._id}`, { isActive: false });

    const createIn = await admin('POST', '/products', { title: 'Into Retired', price: 10, category: cat._id });
    expectStatus(assert, createIn, 400);
    assert.match(createIn.body.errors?.category || '', /inactive/);

    const moveIn = await admin('PUT', `/products/${fx.lace._id}`, { category: cat._id });
    expectStatus(assert, moveIn, 400);
    assert.equal(String((await ctx.models.Product.findById(fx.lace._id)).category), String(fx.laces._id));

    const edit = await admin('PUT', `/products/${product._id}`, { price: 75, category: cat._id });
    expectStatus(assert, edit, 200, 'keeping the current inactive category is allowed');
    assert.equal(edit.body.product.price, 75);
    const moveOut = await admin('PUT', `/products/${product._id}`, { category: String(fx.trims._id) });
    expectStatus(assert, moveOut, 200, 'moving out to an active category is allowed');
  });

  test('CM-13 delete is refused while products, media or sub-categories reference the category', async () => {
    const withProducts = await create({ name: 'Has Products' });
    await addProduct(withProducts);
    await addProduct(withProducts, { isActive: false });
    const r1 = await admin('DELETE', `/categories/${withProducts._id}`);
    expectStatus(assert, r1, 409);
    assert.deepEqual(r1.body.usage, { products: 2, activeProducts: 1, media: 0, children: 0 });
    assert.match(r1.body.message, /2 products/);
    assert.ok(await ctx.models.Category.exists({ _id: withProducts._id }));
    assert.equal(await ctx.models.Product.countDocuments({ category: withProducts._id }), 2, 'products untouched');

    const parent = await create({ name: 'Parent Only' });
    await create({ name: 'Child Only', parent: parent._id });
    const r2 = await admin('DELETE', `/categories/${parent._id}`);
    expectStatus(assert, r2, 409);
    assert.equal(r2.body.usage.children, 1);

    const empty = await create({ name: 'Empty One' });
    expectStatus(assert, await admin('DELETE', `/categories/${empty._id}`), 200);
    expectStatus(assert, await admin('GET', `/categories/manage/${empty._id}`), 404);
  });

  test('CM-14 parent rules: no self-parent, no nesting deeper than one level', async () => {
    const top = await create({ name: 'Top Level' });
    const child = await create({ name: 'Second Level', parent: top._id });
    expectStatus(assert, await admin('PATCH', `/categories/${top._id}`, { parent: top._id }), 400);
    const deep = await admin('POST', '/categories', { name: 'Third Level', parent: child._id });
    expectStatus(assert, deep, 400);
    assert.match(deep.body.errors.parent, /top-level/);
    const hasChildren = await admin('PATCH', `/categories/${top._id}`, { parent: String(fx.trims._id) });
    expectStatus(assert, hasChildren, 400);
    const detach = await admin('PATCH', `/categories/${child._id}`, { parent: null });
    expectStatus(assert, detach, 200);
    assert.equal(detach.body.category.parent, null);
  });

  test('CM-15 malformed and unknown ids → 404; empty update → 400 (no crash)', async () => {
    const unknown = String(new ctx.mongoose.Types.ObjectId());
    for (const id of ['abc', unknown]) {
      expectStatus(assert, await admin('GET', `/categories/manage/${id}`), 404, id);
      expectStatus(assert, await admin('PATCH', `/categories/${id}`, { isActive: false }), 404, id);
      expectStatus(assert, await admin('DELETE', `/categories/${id}`), 404, id);
    }
    expectStatus(assert, await admin('PATCH', `/categories/${fx.trims._id}`, {}), 400);
  });

  test('CM-16 customers and anonymous users cannot use any category admin endpoint', async () => {
    const id = String(fx.trims._id);
    const calls = [
      ['GET', '/categories/manage'], ['GET', `/categories/manage/${id}`],
      ['POST', '/categories', { name: 'Nope' }], ['PATCH', `/categories/${id}`, { isActive: false }],
      ['DELETE', `/categories/${id}`],
    ];
    for (const [method, path, body] of calls) {
      expectStatus(assert, await ctx.request(method, path, { body }), 401, `anon ${method} ${path}`);
      expectStatus(assert, await ctx.request(method, path, { token: fx.tokens.customer, body }), 403, `customer ${method} ${path}`);
    }
    assert.equal((await ctx.models.Category.findById(id)).isActive, true);
  });

  test('CM-17 category image via the secure upload flow: set, replace (old asset kept), delete guarded', async () => {
    const cat = await create({ name: 'Image Cat' });
    const register = (publicId) => admin('POST', '/uploads/assets', { publicId, categoryId: cat._id });
    const first = cloudinary.addResource('parisutra-test/image-cat/one', { tags: ['cat_image_cat'] });
    const second = cloudinary.addResource('parisutra-test/image-cat/two', { tags: ['cat_image_cat'] });
    expectStatus(assert, await register('parisutra-test/image-cat/one'), 201);
    expectStatus(assert, await register('parisutra-test/image-cat/two'), 201);

    const set = await admin('PATCH', `/categories/${cat._id}`, { image: first.secure_url });
    expectStatus(assert, set, 200);
    assert.equal(set.body.category.image, first.secure_url);
    assert.equal((await ctx.request('GET', '/categories/image-cat')).body.category.image, first.secure_url);

    cloudinary.reset();
    const replaced = await admin('PATCH', `/categories/${cat._id}`, { image: second.secure_url });
    expectStatus(assert, replaced, 200);
    assert.deepEqual(cloudinary.destroyed(), [], 'replacing an image never deletes Cloudinary assets');

    const assets = ctx.mongoose.connection.db.collection('mediaassets');
    const inUse = await assets.findOne({ publicId: 'parisutra-test/image-cat/two' });
    const blocked = await admin('DELETE', `/uploads/assets/${inUse._id}`);
    expectStatus(assert, blocked, 409);
    assert.match(blocked.body.message, /1 category/);
    assert.deepEqual(cloudinary.destroyed(), []);

    const unused = await assets.findOne({ publicId: 'parisutra-test/image-cat/one' });
    expectStatus(assert, await admin('DELETE', `/uploads/assets/${unused._id}`), 200);
    assert.deepEqual(cloudinary.destroyed(), ['parisutra-test/image-cat/one']);

    const cleared = await admin('PATCH', `/categories/${cat._id}`, { image: '' });
    expectStatus(assert, cleared, 200);
    assert.equal(cleared.body.category.image, '');

    // Media in the category folder also blocks deleting the category.
    const del = await admin('DELETE', `/categories/${cat._id}`);
    expectStatus(assert, del, 409);
    assert.equal(del.body.usage.media, 1);
  });

  test('CM-18 uploads are refused for inactive categories; no unexpected Cloudinary traffic', async () => {
    const cat = await create({ name: 'No Uploads', isActive: false });
    const sign = await admin('POST', '/uploads/sign', { categoryId: cat._id });
    expectStatus(assert, sign, 400);
    assert.deepEqual(cloudinary.calls.filter((c) => c.type === 'unexpected'), []);
  });
});
