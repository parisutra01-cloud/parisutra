import mongoose from 'mongoose';
import { Product } from '../models/Product.js';
import { MAX_STOCK } from '../utils/stockInput.js';

/**
 * Manual stock operations for admins (Phase 5G.2). Each is ONE conditional atomic update on the
 * product document; nothing is read and then written back, so they cannot overwrite checkout
 * reservations, cancellation restores or other admins' changes.
 *
 *  adjustStock  add:    $inc +q            (result may not exceed MAX_STOCK)
 *               remove: $inc -q only where stock ≥ q  (never negative)
 *  setStock     $set q only where stock still equals expectedStock (compare-and-set); otherwise 409
 *               with the current value.
 *
 * Missing/null stock (legacy documents) means 0, matching the schema default, the admin listing
 * ($ifNull → 0) and checkout reservation (stock ≥ q fails). Only an exact count with expectedStock 0
 * matches such a document; "add" creates the field from 0 (a null value is refused: set it first).
 *
 * trackStock and isActive are never changed: on untracked products stock is kept but not enforced
 * at checkout (existing semantics).
 */

export class StockAdjustmentError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const FIELDS = 'title sku stock trackStock lowStockAlert isActive';
const ZERO_OR_MISSING = [{ stock: 0 }, { stock: { $exists: false } }, { stock: null }];

export const stockValue = (p) => (typeof p.stock === 'number' ? p.stock : 0);

/**
 * Filter condition "stock still equals what the admin saw". expectedStock 0 also matches a missing or
 * null stock (legacy documents count as 0). Used by setStock and by the product edit form (5G.3).
 */
export function expectedStockFilter(expectedStock) {
  return expectedStock === 0 ? { $or: ZERO_OR_MISSING } : { stock: expectedStock };
}

function view(p) {
  return {
    _id: p._id,
    title: p.title,
    sku: p.sku ?? null,
    stock: stockValue(p),
    trackStock: p.trackStock !== false,
    lowStockAlert: p.lowStockAlert ?? 10,
    isActive: p.isActive !== false,
  };
}

function assertId(productId) {
  if (!mongoose.isValidObjectId(productId)) throw new StockAdjustmentError(400, 'Invalid id');
}

async function currentProduct(productId) {
  const product = await Product.findById(productId).select(FIELDS).lean();
  if (!product) throw new StockAdjustmentError(404, 'Product not found');
  return product;
}

/**
 * TEMPORARY diagnostic trail: one structured line per successful manual change, written to the
 * server log. It is not a permanent inventory history (the stock movement log is deferred).
 * Contains no customer data, tokens or payment details.
 */
export function logStockChange(entry) {
  console.log(`[stock-audit] ${JSON.stringify({ event: 'stock.manual_change', ...entry, at: new Date().toISOString() })}`);
}

export async function adjustStock({ productId, operation, quantity, reason, actorId }) {
  assertId(productId);
  const delta = operation === 'add' ? quantity : -quantity;
  const filter = operation === 'add'
    ? { _id: productId, $or: [{ stock: { $lte: MAX_STOCK - quantity } }, { stock: { $exists: false } }] }
    : { _id: productId, stock: { $gte: quantity } };

  const updated = await Product.findOneAndUpdate(filter, { $inc: { stock: delta } }, { new: true, projection: FIELDS }).lean();
  if (!updated) {
    const product = await currentProduct(productId);
    const currentStock = stockValue(product);
    if (operation === 'remove') {
      throw new StockAdjustmentError(409, `Cannot remove ${quantity}: only ${currentStock} in stock`, { currentStock });
    }
    if (product.stock === null) {
      throw new StockAdjustmentError(409, 'This product has no recorded stock value. Set an exact count first (expected stock 0).', { currentStock });
    }
    throw new StockAdjustmentError(409, `Adding ${quantity} would exceed the maximum stock of ${MAX_STOCK.toLocaleString('en-IN')}`, { currentStock });
  }

  const newStock = updated.stock;
  const previousStock = newStock - delta;
  logStockChange({ actorId: String(actorId), productId: String(updated._id), operation, quantity, previousStock, newStock, reason });
  return { product: view(updated), previousStock, change: delta };
}

export async function setStock({ productId, quantity, expectedStock, reason, actorId }) {
  assertId(productId);
  const filter = { _id: productId, ...expectedStockFilter(expectedStock) };

  const updated = await Product.findOneAndUpdate(filter, { $set: { stock: quantity } }, { new: true, projection: FIELDS }).lean();
  if (!updated) {
    const product = await currentProduct(productId);
    const currentStock = stockValue(product);
    throw new StockAdjustmentError(409, `Stock has changed since you looked (now ${currentStock}). Review it and try again.`, { currentStock });
  }

  logStockChange({ actorId: String(actorId), productId: String(updated._id), operation: 'set', quantity, previousStock: expectedStock, newStock: updated.stock, reason });
  return { product: view(updated), previousStock: expectedStock, change: updated.stock - expectedStock };
}
