/**
 * Validation for manual stock operations (Phase 5G.2).
 *
 * Quantity precision follows the existing product rules: stock is a whole number from 0 to
 * MAX_STOCK (productInput.js validates product stock the same way, and order quantities are whole
 * numbers), so adjustments and exact counts are whole numbers too.
 */
export const MAX_STOCK = 10_000_000; // same limit as product stock in utils/productInput.js
export const MAX_REASON_LENGTH = 200;

export class StockInputError extends Error {
  constructor(message, errors) {
    super(message);
    this.status = 400;
    this.errors = errors;
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;

/** Body must be a plain object with only the listed keys (no operators, no extra fields). */
function checkShape(body, allowed) {
  if (!isPlainObject(body)) throw new StockInputError('Request body must be a JSON object');
  const unexpected = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unexpected.length) {
    throw new StockInputError(`Unexpected field(s): ${unexpected.join(', ')}`, Object.fromEntries(unexpected.map((k) => [k, 'not allowed'])));
  }
}

function wholeNumber(value, field, { min, max }) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new StockInputError(`${field} must be a whole number from ${min} to ${max.toLocaleString('en-IN')}`, { [field]: 'invalid' });
  }
  return value;
}

function reason(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StockInputError('A reason is required', { reason: 'required' });
  }
  const text = value.trim().replace(/\s+/g, ' ');
  if (text.length > MAX_REASON_LENGTH) {
    throw new StockInputError(`Reason must be at most ${MAX_REASON_LENGTH} characters`, { reason: 'too long' });
  }
  return text;
}

/** POST /products/:id/stock/adjust → { operation: 'add'|'remove', quantity, reason } */
export function parseStockAdjustment(body) {
  checkShape(body, ['operation', 'quantity', 'reason']);
  if (body.operation !== 'add' && body.operation !== 'remove') {
    throw new StockInputError('operation must be "add" or "remove"', { operation: 'invalid' });
  }
  return {
    operation: body.operation,
    quantity: wholeNumber(body.quantity, 'quantity', { min: 1, max: MAX_STOCK }),
    reason: reason(body.reason),
  };
}

/**
 * POST /products/:id/stock/set → { quantity, expectedStock, reason }
 * expectedStock is only compared, never written, so it may be any finite number the admin saw
 * (including a negative or fractional legacy value that needs correcting).
 */
export function parseStockSet(body) {
  checkShape(body, ['quantity', 'expectedStock', 'reason']);
  const quantity = wholeNumber(body.quantity, 'quantity', { min: 0, max: MAX_STOCK });
  return { quantity, expectedStock: parseExpectedStock(body.expectedStock), reason: reason(body.reason) };
}

/**
 * The stock value the admin saw (compare-and-set guard). Shared by the exact-count endpoint and the
 * product edit form (PUT /products/:id, Phase 5G.3). Any finite JSON number; strings, null, objects
 * and operators are rejected.
 */
export function parseExpectedStock(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new StockInputError('expectedStock must be the stock quantity you saw (a number)', { expectedStock: 'invalid' });
  }
  return value;
}
