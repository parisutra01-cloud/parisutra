import { asyncRouter } from '../utils/asyncRouter.js';
import mongoose from 'mongoose';
import { Category } from '../models/Category.js';
import { Product } from '../models/Product.js';
import { MediaAsset } from '../models/MediaAsset.js';
import { authRequired, adminRequired } from '../middleware/auth.js';
import { escapeRegex } from '../utils/escapeRegex.js';
import { parseCategoryInput, toCategorySlug } from '../utils/categoryInput.js';
import { validationBody } from '../utils/productInput.js';

const router = asyncRouter();

const queryString = (value) => (typeof value === 'string' ? value.trim() : '');
const notFound = (res) => res.status(404).json({ message: 'Category not found' });
const conflict = (res, field, message) => res.status(409).json({ message, errors: { [field]: message } });
const invalid = (res, errors) => res.status(400).json(validationBody(errors));

const SORTS = {
  order: (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  'name-asc': (a, b) => a.name.localeCompare(b.name),
  'name-desc': (a, b) => b.name.localeCompare(a.name),
  newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  oldest: (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  updated: (a, b) => new Date(b.updatedAt) - new Date(a.updatedAt),
  'products-desc': (a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name),
  'products-asc': (a, b) => a.productCount - b.productCount || a.name.localeCompare(b.name),
};

/** Products (all statuses, active only), media assets and sub-categories per category id. */
async function usageByCategory(match = {}) {
  const [products, media, children] = await Promise.all([
    Product.aggregate([
      { $match: match.category ? { category: match.category } : {} },
      {
        $group: {
          _id: '$category',
          total: { $sum: 1 },
          active: { $sum: { $cond: [{ $eq: ['$isActive', false] }, 0, 1] } },
        },
      },
    ]),
    MediaAsset.aggregate([
      { $match: match.category ? { category: match.category } : {} },
      { $group: { _id: '$category', total: { $sum: 1 } } },
    ]),
    Category.aggregate([
      { $match: match.category ? { parent: match.category } : { parent: { $ne: null } } },
      { $group: { _id: '$parent', total: { $sum: 1 } } },
    ]),
  ]);
  const usage = new Map();
  const entry = (id) => {
    const key = String(id);
    if (!usage.has(key)) usage.set(key, { products: 0, activeProducts: 0, media: 0, children: 0 });
    return usage.get(key);
  };
  for (const p of products) Object.assign(entry(p._id), { products: p.total, activeProducts: p.active });
  for (const m of media) entry(m._id).media = m.total;
  for (const c of children) entry(c._id).children = c.total;
  return usage;
}

const EMPTY_USAGE = { products: 0, activeProducts: 0, media: 0, children: 0 };

async function usageFor(id) {
  const usage = await usageByCategory({ category: new mongoose.Types.ObjectId(String(id)) });
  return usage.get(String(id)) || { ...EMPTY_USAGE };
}

/** Case-insensitive name match on another category. */
function nameTaken(name, excludeId) {
  const filter = { name: new RegExp(`^${escapeRegex(name)}$`, 'i') };
  if (excludeId) filter._id = { $ne: excludeId };
  return Category.exists(filter);
}

/** A slug is taken if another category uses it now or used it before (its old URL still resolves there). */
function slugTaken(slug, excludeId) {
  const filter = { $or: [{ slug }, { previousSlugs: slug }] };
  if (excludeId) filter._id = { $ne: excludeId };
  return Category.exists(filter);
}

/** One level of nesting: the parent must exist, be top-level and not be the category itself. */
async function parentError(parentId, selfId) {
  if (!parentId) return null;
  if (selfId && String(parentId) === String(selfId)) return 'a category cannot be its own parent';
  const parent = await Category.findById(parentId).select('parent');
  if (!parent) return 'parent category does not exist';
  if (parent.parent) return 'parent must be a top-level category';
  if (selfId && (await Category.exists({ parent: selfId }))) {
    return 'this category has sub-categories, so it cannot be placed under another category';
  }
  return null;
}

router.get('/', async (_req, res) => {
  const categories = await Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 });
  res.json({ categories });
});

/**
 * Admin listing: every status, with product/media/sub-category counts.
 * Query: q, status (all|active|inactive), sort (see SORTS), page + limit (optional; all rows without limit).
 */
router.get('/manage', authRequired, adminRequired, async (req, res) => {
  // Only plain strings are accepted (blocks operator objects such as ?status[$ne]=x).
  if (['q', 'status', 'sort', 'page', 'limit'].some((k) => req.query[k] !== undefined && typeof req.query[k] !== 'string')) {
    return res.status(400).json({ message: 'Invalid query parameter' });
  }
  const status = queryString(req.query.status) || 'all';
  if (!['all', 'active', 'inactive'].includes(status)) return res.status(400).json({ message: 'Invalid status filter' });
  const sort = queryString(req.query.sort) || 'order';
  if (!SORTS[sort]) return res.status(400).json({ message: 'Invalid sort' });
  const q = queryString(req.query.q).slice(0, 100);

  const [all, usage] = await Promise.all([Category.find().lean(), usageByCategory()]);
  const names = new Map(all.map((c) => [String(c._id), c.name]));
  const rows = all.map((c) => {
    const u = usage.get(String(c._id)) || EMPTY_USAGE;
    return {
      ...c,
      productCount: u.products,
      activeProductCount: u.activeProducts,
      mediaCount: u.media,
      childCount: u.children,
      parentName: c.parent ? names.get(String(c.parent)) || null : null,
    };
  });

  const stats = {
    total: rows.length,
    active: rows.filter((c) => c.isActive !== false).length,
    inactive: rows.filter((c) => c.isActive === false).length,
    products: rows.reduce((sum, c) => sum + c.productCount, 0),
    empty: rows.filter((c) => c.productCount === 0).length,
  };

  const pattern = q ? new RegExp(escapeRegex(q), 'i') : null;
  const filtered = rows
    .filter((c) => status === 'all' || (status === 'active' ? c.isActive !== false : c.isActive === false))
    .filter((c) => !pattern || pattern.test(c.name) || pattern.test(c.slug) || pattern.test(c.description || ''))
    .sort(SORTS[sort]);

  const total = filtered.length;
  const limitRaw = Number.parseInt(queryString(req.query.limit), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, limitRaw)) : Math.max(total, 1);
  const pages = Math.max(1, Math.ceil(total / limit));
  const pageRaw = Number.parseInt(queryString(req.query.page), 10);
  const page = Number.isFinite(pageRaw) ? Math.min(pages, Math.max(1, pageRaw)) : 1;
  const categories = filtered.slice((page - 1) * limit, page * limit);

  res.json({ categories, pagination: { page, limit, total, pages }, stats });
});

router.get('/manage/:id', authRequired, adminRequired, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
  const category = await Category.findById(req.params.id).populate('parent', 'name slug');
  if (!category) return notFound(res);
  res.json({ category, usage: await usageFor(category._id) });
});

router.post('/', authRequired, adminRequired, async (req, res, next) => {
  const { data, errors } = parseCategoryInput(req.body);
  if (!errors.name && !errors.slug && !data.slug) {
    data.slug = toCategorySlug(data.name);
    if (!data.slug) errors.slug = 'enter a URL slug (the name has no letters or numbers to build one from)';
  }
  if (Object.keys(errors).length) return invalid(res, errors);

  if (await nameTaken(data.name)) return conflict(res, 'name', 'Category already exists');
  if (await slugTaken(data.slug)) return conflict(res, 'slug', 'Slug already exists');
  const badParent = await parentError(data.parent);
  if (badParent) return invalid(res, { parent: badParent });

  if (data.sortOrder === undefined) {
    const last = await Category.findOne().sort({ sortOrder: -1 }).select('sortOrder');
    data.sortOrder = (last?.sortOrder || 0) + 1;
  }
  try {
    const category = await Category.create({ isActive: true, ...data });
    res.status(201).json({ category });
  } catch (err) {
    if (err?.code === 11000) return conflict(res, 'slug', 'Category already exists');
    next(err);
  }
});

/**
 * Partial update. Renaming without an explicit slug regenerates the slug from the name; in every
 * case the old slug is kept in previousSlugs so existing storefront links keep working.
 * Products reference categories by id, so renames and slug changes never touch products.
 */
router.patch('/:id', authRequired, adminRequired, async (req, res, next) => {
  if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
  const existing = await Category.findById(req.params.id);
  if (!existing) return notFound(res);

  const { data, errors } = parseCategoryInput(req.body, { partial: true });
  if (Object.keys(errors).length) return invalid(res, errors);
  if (!Object.keys(data).length) return invalid(res, { name: 'nothing to update' });

  if (data.name && data.slug === undefined && data.name !== existing.name) {
    const derived = toCategorySlug(data.name);
    if (derived && derived !== existing.slug) data.slug = derived;
  }
  if (data.name && (await nameTaken(data.name, existing._id))) return conflict(res, 'name', 'Category already exists');
  if (data.slug && data.slug !== existing.slug && (await slugTaken(data.slug, existing._id))) {
    return conflict(res, 'slug', 'Slug already exists');
  }
  if (data.parent !== undefined) {
    const badParent = await parentError(data.parent, existing._id);
    if (badParent) return invalid(res, { parent: badParent });
  }

  const update = { $set: data };
  if (data.slug && data.slug !== existing.slug) {
    update.$set.previousSlugs = [...new Set([...(existing.previousSlugs || []), existing.slug])]
      .filter((s) => s !== data.slug);
  }
  try {
    const category = await Category.findByIdAndUpdate(existing._id, update, { new: true, runValidators: true });
    res.json({ category, usage: await usageFor(category._id) });
  } catch (err) {
    if (err?.code === 11000) return conflict(res, 'slug', 'Slug already exists');
    next(err);
  }
});

/**
 * Permanent delete, allowed only for a category nothing points at. A category that still has
 * products (active or not), media assets or sub-categories is refused with the counts, so product
 * references can never be orphaned; deactivate it instead.
 */
router.delete('/:id', authRequired, adminRequired, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return notFound(res);
  const category = await Category.findById(req.params.id);
  if (!category) return notFound(res);
  const usage = await usageFor(category._id);
  if (usage.products || usage.media || usage.children) {
    const parts = [];
    if (usage.products) parts.push(`${usage.products} product${usage.products === 1 ? '' : 's'}`);
    if (usage.media) parts.push(`${usage.media} media file${usage.media === 1 ? '' : 's'}`);
    if (usage.children) parts.push(`${usage.children} sub-categor${usage.children === 1 ? 'y' : 'ies'}`);
    return res.status(409).json({
      message: `This category still has ${parts.join(', ')}. Move them first, or deactivate the category instead.`,
      usage,
    });
  }
  await Category.deleteOne({ _id: category._id });
  res.json({ ok: true });
});

/** Public lookup by current or previous slug (renamed categories keep their old URLs). */
router.get('/:slug', async (req, res) => {
  const slug = queryString(req.params.slug).toLowerCase();
  const category = await Category.findOne({ slug, isActive: true })
    || await Category.findOne({ previousSlugs: slug, isActive: true });
  if (!category) return notFound(res);
  res.json({ category });
});

export default router;
