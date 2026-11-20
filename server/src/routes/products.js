import mongoose from 'mongoose';
import { asyncRouter } from '../utils/asyncRouter.js';
import { Product } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { authRequired, adminRequired } from '../middleware/auth.js';
import { slugify } from '../utils/slugify.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { parseProductInput, crossFieldErrors, validationBody } from '../utils/productInput.js';
import { StockInputError, parseStockAdjustment, parseStockSet, parseExpectedStock } from '../utils/stockInput.js';
import {
  StockAdjustmentError, adjustStock, setStock, expectedStockFilter, stockValue, logStockChange,
} from '../services/stockAdjustment.js';

const router = asyncRouter();

/** Fields never exposed on public (storefront) endpoints. */
const PUBLIC_PROJECTION = '-costPrice';

/** Only plain strings are accepted from the query string (blocks operator objects like ?x[$ne]=y). */
const queryString = (value) => (typeof value === 'string' ? value.trim() : '');

function clampInt(value, fallback, min, max) {
  const n = Number.parseInt(queryString(value), 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function badRequest(res, message) {
  return res.status(400).json({ message });
}

function buildProductFilter(query) {
  const filter = { isActive: true };
  const category = queryString(query.category);
  const q = queryString(query.q);
  const { minPrice, maxPrice, featured, newArrivals, inStock } = query;

  const emptyString = typeof query.category === 'string' && category === '';
  if (query.category !== undefined && !emptyString) {
    if (!mongoose.isValidObjectId(category)) return { error: 'Invalid category' };
    filter.category = category;
  }
  if (featured === 'true') filter.isFeatured = true;
  if (newArrivals === 'true') filter.isNewArrival = true;
  if (inStock === 'true') filter.stock = { $gt: 0 };
  const min = Number(queryString(minPrice));
  const max = Number(queryString(maxPrice));
  if (queryString(minPrice) || queryString(maxPrice)) {
    filter.price = {};
    if (queryString(minPrice) && Number.isFinite(min)) filter.price.$gte = min;
    if (queryString(maxPrice) && Number.isFinite(max)) filter.price.$lte = max;
  }
  const listFilter = (raw) => queryString(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (queryString(query.material)) filter.material = { $in: listFilter(query.material) };
  if (queryString(query.color)) filter.colors = { $in: listFilter(query.color) };
  if (queryString(query.style)) filter.styles = { $in: listFilter(query.style) };
  if (q) filter.$text = { $search: q };
  return { filter };
}

// ——— Public (storefront) ———

router.get('/', async (req, res) => {
  const page = clampInt(req.query.page, 1, 1, 100000);
  const limit = clampInt(req.query.limit, 12, 1, 48);
  const skip = (page - 1) * limit;
  const sortKey = queryString(req.query.sort);
  const sort = sortKey === 'price-asc'
    ? { price: 1 }
    : sortKey === 'price-desc'
      ? { price: -1 }
      : sortKey === 'featured'
        ? { isFeatured: -1, createdAt: -1 }
        : { createdAt: -1 };

  const built = buildProductFilter(req.query);
  if (built.error) return badRequest(res, built.error);
  let { filter } = built;
  const q = queryString(req.query.q);
  const categorySlug = queryString(req.query.categorySlug);
  if (req.query.categorySlug !== undefined) {
    // Inactive categories are hidden from the storefront; renamed ones still resolve by their old slug.
    const slug = categorySlug.toLowerCase();
    const cat = categorySlug
      ? (await Category.findOne({ slug, isActive: true })) || (await Category.findOne({ previousSlugs: slug, isActive: true }))
      : null;
    if (!cat) return res.json({ products: [], pagination: { page, limit, total: 0, pages: 0 } });
    filter = { ...filter, category: cat._id };
    delete filter.$text;
    if (q) {
      const pattern = new RegExp(escapeRegex(q.slice(0, 100)), 'i');
      filter.$or = [{ title: pattern }, { shortDescription: pattern }];
    }
  }

  const [products, total] = await Promise.all([
    Product.find(filter).select(PUBLIC_PROJECTION).populate('category', 'name slug').sort(sort).skip(skip).limit(limit),
    Product.countDocuments(filter),
  ]);

  res.json({
    products,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

router.get('/slug/:slug', async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug, isActive: true })
    .select(PUBLIC_PROJECTION)
    .populate('category', 'name slug');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json({ product });
});

// ——— Admin ———

const ADMIN_SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  updated: { updatedAt: -1 },
  'price-asc': { price: 1 },
  'price-desc': { price: -1 },
  'stock-asc': { stock: 1 },
  'stock-desc': { stock: -1 },
  'title-asc': { title: 1 },
};

// Low stock: tracked, in stock, and at or below its own alert level (default 10 for older documents).
const LOW_STOCK_EXPR = {
  $and: [
    { $ne: ['$trackStock', false] },
    { $gt: [{ $ifNull: ['$stock', 0] }, 0] },
    { $lte: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$lowStockAlert', 10] }] },
  ],
};
const OUT_OF_STOCK_EXPR = { $and: [{ $ne: ['$trackStock', false] }, { $lte: [{ $ifNull: ['$stock', 0] }, 0] }] };
const IN_STOCK_EXPR = {
  $or: [
    { $eq: ['$trackStock', false] },
    { $gt: [{ $ifNull: ['$stock', 0] }, { $ifNull: ['$lowStockAlert', 10] }] },
  ],
};

async function productStats() {
  const [s] = await Product.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        active: { $sum: { $cond: [{ $ne: ['$isActive', false] }, 1, 0] } },
        lowStock: { $sum: { $cond: [LOW_STOCK_EXPR, 1, 0] } },
        outOfStock: { $sum: { $cond: [OUT_OF_STOCK_EXPR, 1, 0] } },
      },
    },
  ]);
  const stats = s || { total: 0, active: 0, lowStock: 0, outOfStock: 0 };
  return { total: stats.total, active: stats.active, inactive: stats.total - stats.active, lowStock: stats.lowStock, outOfStock: stats.outOfStock };
}

/** Admin product list: every status, search by title/SKU/slug, filters, sorting, pagination, KPI stats. */
router.get('/manage', authRequired, adminRequired, async (req, res) => {
  const page = clampInt(req.query.page, 1, 1, 100000);
  const limit = clampInt(req.query.limit, 20, 1, 100);
  const filter = {};

  const q = queryString(req.query.q).slice(0, 100);
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ title: pattern }, { sku: pattern }, { slug: pattern }];
  }
  const category = queryString(req.query.category);
  if (category) {
    if (!mongoose.isValidObjectId(category)) return badRequest(res, 'Invalid category filter');
    filter.category = category;
  }
  const status = queryString(req.query.status) || 'all';
  if (status === 'active') filter.isActive = { $ne: false };
  else if (status === 'inactive') filter.isActive = false;
  else if (status !== 'all') return badRequest(res, 'Invalid status filter');

  const stock = queryString(req.query.stock) || 'all';
  if (stock === 'low') filter.$expr = LOW_STOCK_EXPR;
  else if (stock === 'out') filter.$expr = OUT_OF_STOCK_EXPR;
  else if (stock === 'in') filter.$expr = IN_STOCK_EXPR;
  else if (stock !== 'all') return badRequest(res, 'Invalid stock filter');

  const sort = { ...(ADMIN_SORTS[queryString(req.query.sort)] || ADMIN_SORTS.newest), _id: -1 };

  const [products, total, stats] = await Promise.all([
    Product.find(filter).populate('category', 'name slug').sort(sort).skip((page - 1) * limit).limit(limit),
    Product.countDocuments(filter),
    productStats(),
  ]);
  res.json({ products, pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) }, stats });
});

/** Admin product detail (any status, includes costPrice). */
router.get('/manage/:id', authRequired, adminRequired, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return badRequest(res, 'Invalid id');
  const product = await Product.findById(req.params.id).populate('category', 'name slug');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json({ product });
});

/** Public product detail by id: active products only, no internal fields. */
router.get('/:id', async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return badRequest(res, 'Invalid id');
  const product = await Product.findOne({ _id: req.params.id, isActive: true })
    .select(PUBLIC_PROJECTION)
    .populate('category', 'name slug');
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json({ product });
});

async function skuTaken(sku, excludeId) {
  const filter = { sku: new RegExp(`^${escapeRegex(sku)}$`, 'i') };
  if (excludeId) filter._id = { $ne: excludeId };
  return Boolean(await Product.exists(filter));
}

async function slugTaken(slug, excludeId) {
  const filter = { slug };
  if (excludeId) filter._id = { $ne: excludeId };
  return Boolean(await Product.exists(filter));
}

function conflict(res, field, message) {
  return res.status(409).json({ message, errors: { [field]: message } });
}

/** Splits parsed data into $set / $unset (blank optional fields are removed). */
function toUpdate(data) {
  const $set = {};
  const $unset = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) $unset[key] = '';
    else $set[key] = value;
  }
  const update = {};
  if (Object.keys($set).length) update.$set = $set;
  if (Object.keys($unset).length) update.$unset = $unset;
  return update;
}

/** New category assignments must point at an existing, active category. */
async function assignableCategoryError(categoryId) {
  const category = await Category.findById(categoryId).select('isActive');
  if (!category) return 'category does not exist';
  if (category.isActive === false) return 'category is inactive; activate it or choose another category';
  return null;
}

router.post('/', authRequired, adminRequired, async (req, res, next) => {
  const { data, errors } = parseProductInput(req.body);
  Object.assign(errors, crossFieldErrors(data));
  if (!errors.slug && !errors.title && !data.slug) {
    data.slug = slugify(data.title).replace(/_/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!data.slug) errors.slug = 'enter a URL slug (the title has no letters or numbers to build one from)';
  }
  if (Object.keys(errors).length) return res.status(400).json(validationBody(errors));

  const categoryError = await assignableCategoryError(data.category);
  if (categoryError) return res.status(400).json(validationBody({ category: categoryError }));
  if (data.sku && (await skuTaken(data.sku))) return conflict(res, 'sku', 'SKU already exists');
  if (await slugTaken(data.slug)) return conflict(res, 'slug', 'Slug already exists');

  const { $set } = toUpdate(data);
  try {
    const product = await Product.create($set);
    await product.populate('category', 'name slug');
    res.status(201).json({ product });
  } catch (err) {
    if (err?.code === 11000) return conflict(res, 'slug', 'Slug already exists');
    next(err);
  }
});

/**
 * Stock on a product edit (Phase 5G.3). Omitted stock is never written. A stock change must carry
 * expectedStock (the value shown when the form was opened); it is applied only if the database still
 * holds that value, in the same atomic update as the other edits. Returns { expectedStock } or errors.
 */
function editStockGuard(body, errors) {
  const own = (key) => body !== null && typeof body === 'object' && Object.prototype.hasOwnProperty.call(body, key);
  if (!own('stock')) {
    if (own('expectedStock')) errors.expectedStock = 'expectedStock is only accepted together with a stock change';
    return null;
  }
  if (!own('expectedStock')) {
    errors.expectedStock = 'expectedStock (the stock shown when you opened the product) is required to change stock';
    return null;
  }
  try {
    return { expectedStock: parseExpectedStock(body.expectedStock) };
  } catch (err) {
    errors.expectedStock = err.message;
    return null;
  }
}

router.put('/:id', authRequired, adminRequired, async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return badRequest(res, 'Invalid id');
  const existing = await Product.findById(req.params.id);
  if (!existing) return res.status(404).json({ message: 'Product not found' });

  const { data, errors } = parseProductInput(req.body, { partial: true });
  const stockGuard = editStockGuard(req.body, errors);
  Object.assign(errors, crossFieldErrors({ ...existing.toObject(), ...data }));
  if (Object.keys(errors).length) return res.status(400).json(validationBody(errors));

  // Keeping a product's current (possibly inactive) category is always allowed; moving it needs an active one.
  if (data.category && String(existing.category) !== data.category) {
    const categoryError = await assignableCategoryError(data.category);
    if (categoryError) return res.status(400).json(validationBody({ category: categoryError }));
  }
  if (data.sku && (await skuTaken(data.sku, existing._id))) return conflict(res, 'sku', 'SKU already exists');
  if (data.slug && data.slug !== existing.slug && (await slugTaken(data.slug, existing._id))) {
    return conflict(res, 'slug', 'Slug already exists');
  }

  // One atomic update: when stock is changed, the filter also requires the stock the admin saw, so a
  // sale, cancellation or another admin's change in the meantime makes the whole edit fail (409)
  // instead of being overwritten. Without a stock change, stock is not in the update at all.
  const update = toUpdate(data);
  const filter = { _id: existing._id, ...(stockGuard ? expectedStockFilter(stockGuard.expectedStock) : {}) };
  try {
    const product = await Product.findOneAndUpdate(filter, update, { new: true, runValidators: true })
      .populate('category', 'name slug');
    if (!product) {
      const current = await Product.findById(existing._id).select('stock').lean();
      if (!current) return res.status(404).json({ message: 'Product not found' });
      const currentStock = stockValue(current);
      const message = `Stock changed while this form was open (now ${currentStock}). Nothing was saved. Review the current quantity, then save again.`;
      return res.status(409).json({ message, code: 'STOCK_CONFLICT', currentStock, errors: { stock: message } });
    }
    if (stockGuard) {
      logStockChange({
        actorId: String(req.userId), productId: String(product._id), operation: 'product_edit', quantity: product.stock,
        previousStock: stockGuard.expectedStock, newStock: product.stock, reason: 'Product edit form',
      });
    }
    res.json({ product });
  } catch (err) {
    if (err?.code === 11000) return conflict(res, 'slug', 'Slug already exists');
    next(err);
  }
});

/* ── Manual stock operations (Phase 5G.2): atomic, admin only, reason required ─────────── */

function stockError(res, err) {
  if (err instanceof StockInputError) return res.status(400).json({ message: err.message, ...(err.errors ? { errors: err.errors } : {}) });
  if (err instanceof StockAdjustmentError) return res.status(err.status).json({ message: err.message, ...err.extra });
  throw err;
}

/** Add or remove units: { operation: 'add' | 'remove', quantity, reason }. */
router.post('/:id/stock/adjust', authRequired, adminRequired, async (req, res) => {
  try {
    const input = parseStockAdjustment(req.body);
    res.json(await adjustStock({ productId: req.params.id, ...input, actorId: req.userId }));
  } catch (err) {
    stockError(res, err);
  }
});

/** Physical recount: { quantity, expectedStock, reason }; 409 + currentStock if stock changed. */
router.post('/:id/stock/set', authRequired, adminRequired, async (req, res) => {
  try {
    const input = parseStockSet(req.body);
    res.json(await setStock({ productId: req.params.id, ...input, actorId: req.userId }));
  } catch (err) {
    stockError(res, err);
  }
});

/**
 * Soft delete: the product is hidden from the storefront (isActive=false) but kept, because orders,
 * wishlists and reports reference it. It can be restored from the edit page (status → Active).
 */
router.delete('/:id', authRequired, adminRequired, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return badRequest(res, 'Invalid id');
  const product = await Product.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
  if (!product) return res.status(404).json({ message: 'Product not found' });
  res.json({ product });
});

export default router;
