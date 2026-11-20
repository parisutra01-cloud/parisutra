import { Product } from '../models/Product.js';

/**
 * Inventory read model (Phase 5G.4). Read-only: stock is written only by the atomic operations in
 * services/stockAdjustment.js and the guarded product update.
 *
 * Stock status matches checkout (orderService reserveLine): a product with trackStock === false is
 * never blocked by stock, so it is "not tracked" rather than in/low/out of stock. For tracked
 * products a missing/null stock counts as 0 (schema default, 5G.2 semantics) and lowStockAlert
 * defaults to 10 for older documents.
 */

export const STOCK_STATUSES = ['in_stock', 'low_stock', 'out_of_stock', 'not_tracked'];

const TRACKED = { $ne: ['$trackStock', false] };
const STOCK = { $ifNull: ['$stock', 0] };
const ALERT = { $ifNull: ['$lowStockAlert', 10] };

export const LOW_STOCK_EXPR = { $and: [TRACKED, { $gt: [STOCK, 0] }, { $lte: [STOCK, ALERT] }] };
export const OUT_OF_STOCK_EXPR = { $and: [TRACKED, { $lte: [STOCK, 0] }] };
/** Tracked and above its alert level (untracked products have their own status here). */
export const TRACKED_IN_STOCK_EXPR = { $and: [TRACKED, { $gt: [STOCK, ALERT] }] };
export const NOT_TRACKED_EXPR = { $eq: ['$trackStock', false] };

/** Inventory filter values → $expr. */
export const INVENTORY_STOCK_FILTERS = {
  in: TRACKED_IN_STOCK_EXPR,
  low: LOW_STOCK_EXPR,
  out: OUT_OF_STOCK_EXPR,
  untracked: NOT_TRACKED_EXPR,
};

export function stockStatus(p) {
  if (p.trackStock === false) return 'not_tracked';
  const stock = typeof p.stock === 'number' ? p.stock : 0;
  if (stock <= 0) return 'out_of_stock';
  if (stock <= (p.lowStockAlert ?? 10)) return 'low_stock';
  return 'in_stock';
}

/** Only what the inventory screen needs: no prices, cost price, descriptions or SEO fields. */
export const INVENTORY_PROJECTION = 'title sku slug unit stock lowStockAlert trackStock isActive images category updatedAt';

export function toInventoryItem(p) {
  const image = p.images?.find((i) => i.isMain)?.url || p.images?.[0]?.url || null;
  return {
    _id: p._id,
    title: p.title,
    sku: p.sku ?? null,
    slug: p.slug,
    unit: p.unit ?? 'meter',
    image,
    category: p.category && typeof p.category === 'object' && p.category.name
      ? { _id: p.category._id, name: p.category.name }
      : null,
    stock: typeof p.stock === 'number' ? p.stock : 0,
    stockRecorded: typeof p.stock === 'number',
    lowStockAlert: p.lowStockAlert ?? 10,
    trackStock: p.trackStock !== false,
    isActive: p.isActive !== false,
    stockStatus: stockStatus(p),
    updatedAt: p.updatedAt ?? null,
  };
}

export async function inventoryStats() {
  const one = (expr) => ({ $sum: { $cond: [expr, 1, 0] } });
  const [s] = await Product.aggregate([
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        inStock: one(TRACKED_IN_STOCK_EXPR),
        lowStock: one(LOW_STOCK_EXPR),
        outOfStock: one(OUT_OF_STOCK_EXPR),
        notTracked: one(NOT_TRACKED_EXPR),
        inactive: one({ $eq: ['$isActive', false] }),
      },
    },
  ]);
  const { _id, ...stats } = s || { total: 0, inStock: 0, lowStock: 0, outOfStock: 0, notTracked: 0, inactive: 0 };
  return stats;
}
