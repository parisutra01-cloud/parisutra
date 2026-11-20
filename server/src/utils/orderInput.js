import mongoose from 'mongoose';
import { Order } from '../models/Order.js';
import { escapeRegex } from './escapeRegex.js';

/**
 * Input safety for customer orders (Milestone 5A).
 *
 * Limits:
 * - MAX_QUANTITY_PER_PRODUCT: 1000 units of one product per order (after merging repeated lines).
 *   Retail quantities are far lower; larger volumes go through the wholesale enquiry flow.
 * - MAX_CART_LINES: 50 distinct products per order.
 */
export const MAX_QUANTITY_PER_PRODUCT = 1000;
export const MAX_CART_LINES = 50;
/** Lines are checked before merging too, so a huge payload is rejected without further work. */
const MAX_RAW_LINES = 200;

/** The single source of truth for order statuses is the Order schema. */
export const ORDER_STATUSES = Order.schema.path('status').enumValues;

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;
const isBlank = (v) => v === undefined || v === null || v === '';

export class OrderInputError extends Error {
  constructor(message, errors) {
    super(message);
    this.status = 400;
    this.errors = errors;
  }
}

/**
 * Validates and normalises the cart sent to POST /orders.
 * Returns [{ productId, quantity }] with repeated products merged (first-seen order kept).
 * Throws OrderInputError (400) on any problem; nothing is coerced into a "valid" value.
 *
 * Recognised line fields: productId, quantity. Variation fields are rejected because variation
 * stock and pricing are not supported yet. Other plain (string/number/boolean) fields are ignored
 * (e.g. a client-sent price; prices always come from the database); nested objects/arrays are rejected.
 */
export function parseCartItems(items) {
  if (!Array.isArray(items)) throw new OrderInputError('Cart items must be a list', { items: 'must be an array' });
  if (items.length === 0) throw new OrderInputError('Cart is empty', { items: 'cart is empty' });
  if (items.length > MAX_RAW_LINES) {
    throw new OrderInputError(`A cart can contain at most ${MAX_CART_LINES} products`, { items: 'too many lines' });
  }

  const merged = new Map();
  items.forEach((line, index) => {
    const n = index + 1;
    const fail = (field, message) => {
      throw new OrderInputError(`Cart line ${n}: ${message}`, { [`items.${index}${field ? `.${field}` : ''}`]: message });
    };
    if (!isPlainObject(line)) fail('', 'each cart line must be an object');

    for (const [key, value] of Object.entries(line)) {
      if (key === 'variationId' || key === 'variationLabel') {
        if (!isBlank(value)) fail(key, 'product variations cannot be ordered yet');
      } else if (value !== null && typeof value === 'object') {
        fail(key, 'unexpected nested value');
      }
    }

    const { productId, quantity } = line;
    if (typeof productId !== 'string' || !OBJECT_ID.test(productId) || !mongoose.isValidObjectId(productId)) {
      fail('productId', 'invalid product id');
    }
    if (typeof quantity !== 'number' || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY_PER_PRODUCT) {
      fail('quantity', `quantity must be a whole number from 1 to ${MAX_QUANTITY_PER_PRODUCT}`);
    }

    const key = productId.toLowerCase();
    merged.set(key, (merged.get(key) || 0) + quantity);
  });

  if (merged.size > MAX_CART_LINES) {
    throw new OrderInputError(`A cart can contain at most ${MAX_CART_LINES} products`, { items: 'too many products' });
  }
  const lines = [];
  for (const [productId, quantity] of merged) {
    if (quantity > MAX_QUANTITY_PER_PRODUCT) {
      throw new OrderInputError(
        `At most ${MAX_QUANTITY_PER_PRODUCT} units of one product can be ordered at once`,
        { items: `product ${productId} exceeds ${MAX_QUANTITY_PER_PRODUCT} units` },
      );
    }
    lines.push({ productId, quantity });
  }
  return lines;
}

const ADDRESS_FIELDS = ['fullName', 'phone', 'line1', 'line2', 'city', 'state', 'pincode'];

/**
 * Shipping address: a plain object whose known fields are short plain strings. line1 and pincode
 * are required (same rule as before). Unknown fields are dropped.
 */
export function parseShippingAddress(address) {
  if (!isPlainObject(address)) {
    throw new OrderInputError('Complete shipping address is required', { shippingAddress: 'required' });
  }
  const out = {};
  for (const field of ADDRESS_FIELDS) {
    const value = address[field];
    if (isBlank(value)) continue;
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new OrderInputError(`Shipping address ${field} must be text`, { [`shippingAddress.${field}`]: 'invalid' });
    }
    const text = String(value).trim();
    if (text.length > 200) {
      throw new OrderInputError(`Shipping address ${field} is too long`, { [`shippingAddress.${field}`]: 'too long' });
    }
    if (text) out[field] = text;
  }
  if (!out.line1 || !out.pincode) {
    throw new OrderInputError('Complete shipping address is required', { shippingAddress: 'line1 and pincode are required' });
  }
  return out;
}

/**
 * Status filter for order listings. Absent or empty → no filter.
 * Only a single plain string from ORDER_STATUSES is accepted (no arrays or operator objects).
 */
export function parseStatusFilter(value) {
  if (value === undefined || value === '') return null;
  if (typeof value !== 'string' || !ORDER_STATUSES.includes(value)) {
    throw new OrderInputError(`Invalid status filter. Use one of: ${ORDER_STATUSES.join(', ')}`, { status: 'invalid status' });
  }
  return value;
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Optional free-text customer fields (name, phone): plain strings with a length cap, or absent. */
export function optionalText(value, field, max) {
  if (isBlank(value)) return undefined;
  if (typeof value !== 'string' || value.trim().length > max) {
    throw new OrderInputError(`${field} must be text of at most ${max} characters`, { [field]: 'invalid' });
  }
  return value.trim() || undefined;
}

/** Validates the public tracking lookup. Returns a Mongo filter on plain strings only. */
export function parseTrackingQuery(query) {
  const { orderNumber, email } = query || {};
  if (isBlank(orderNumber) || isBlank(email)) {
    throw new OrderInputError('Order number and email are required');
  }
  if (typeof orderNumber !== 'string' || typeof email !== 'string') {
    throw new OrderInputError('Order number and email must be text');
  }
  const number = orderNumber.trim().toUpperCase();
  const mail = normalizeEmail(email);
  if (!/^[A-Z0-9-]{1,32}$/.test(number)) throw new OrderInputError('Enter a valid order number');
  if (mail.length > 254 || !EMAIL.test(mail)) throw new OrderInputError('Enter a valid email address');
  // Case-insensitive on the stored email so older orders saved with mixed case still match.
  return { orderNumber: number, customerEmail: new RegExp(`^${escapeRegex(mail)}$`, 'i') };
}

/**
 * Public tracking view: an explicit allowlist. No address, phone, email, user id, payment data
 * or internal ids are included.
 */
export function toTrackingView(order) {
  const items = (order.items || []).map((i) => ({
    title: i.title,
    quantity: i.quantity,
    unit: i.unit,
    image: i.image,
  }));
  return {
    orderNumber: order.orderNumber,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    total: order.total,
    itemCount: items.length,
    items,
  };
}

/* ── Admin order listing and dashboard (Milestone 5E) ─────────────────────────────────────── */

export const ORDER_LIST_DEFAULT_LIMIT = 20;
export const ORDER_LIST_MAX_LIMIT = 100;
export const PAYMENT_STATUSES = Order.schema.path('paymentStatus').enumValues;
/**
 * Dates are calendar days (YYYY-MM-DD) in India Standard Time, the store's timezone. IST is a
 * fixed UTC+05:30 offset (no daylight saving), so day boundaries are exact. `from` includes the
 * whole start day; `to` includes the whole end day.
 */
export const ORDER_TIMEZONE = { name: 'Asia/Kolkata', utcOffsetMinutes: 330 };
const MAX_SEARCH_LENGTH = 100;

function plainString(query, key) {
  const value = query[key];
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new OrderInputError(`${key} must be a single text value`, { [key]: 'invalid' });
  return value.trim();
}

function positiveInt(query, key, fallback, max) {
  const raw = plainString(query, key);
  if (raw === undefined) return fallback;
  if (!/^\d{1,6}$/.test(raw) || Number(raw) < 1) {
    throw new OrderInputError(`${key} must be a whole number of at least 1`, { [key]: 'invalid' });
  }
  const n = Number(raw);
  if (max && n > max) throw new OrderInputError(`${key} can be at most ${max}`, { [key]: `max ${max}` });
  return n;
}

/** Start of an IST calendar day as a UTC Date; null if the string is not a real YYYY-MM-DD date. */
function istDayStart(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const utc = Date.UTC(y, mo - 1, d);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  return new Date(utc - ORDER_TIMEZONE.utcOffsetMinutes * 60 * 1000);
}

/** Optional from/to (IST calendar days) → { createdAt: { $gte, $lt } } plus the echoed range. */
export function parseDateRange(query) {
  const from = plainString(query, 'from');
  const to = plainString(query, 'to');
  const range = {};
  let start;
  let end;
  if (from !== undefined) {
    start = istDayStart(from);
    if (!start) throw new OrderInputError('from must be a valid date (YYYY-MM-DD)', { from: 'invalid date' });
    range.$gte = start;
  }
  if (to !== undefined) {
    const endDay = istDayStart(to);
    if (!endDay) throw new OrderInputError('to must be a valid date (YYYY-MM-DD)', { to: 'invalid date' });
    end = new Date(endDay.getTime() + 24 * 60 * 60 * 1000);
    range.$lt = end;
  }
  if (start && end && start >= end) throw new OrderInputError('from must not be later than to', { from: 'after to' });
  return {
    createdAt: Object.keys(range).length ? range : undefined,
    range: { from: from ?? null, to: to ?? null, timezone: ORDER_TIMEZONE.name },
  };
}

/**
 * GET /orders (admin): page, limit, status, paymentStatus, from, to, q.
 * Returns a Mongo filter built only from fixed field names and validated values.
 */
export function parseOrderListQuery(query = {}) {
  const page = positiveInt(query, 'page', 1);
  const limit = positiveInt(query, 'limit', ORDER_LIST_DEFAULT_LIMIT, ORDER_LIST_MAX_LIMIT);
  const filter = {};

  const status = parseStatusFilter(query.status);
  if (status) filter.status = status;

  const paymentStatus = plainString(query, 'paymentStatus');
  if (paymentStatus !== undefined) {
    if (!PAYMENT_STATUSES.includes(paymentStatus)) {
      throw new OrderInputError(`Invalid payment status. Use one of: ${PAYMENT_STATUSES.join(', ')}`, { paymentStatus: 'invalid' });
    }
    filter.paymentStatus = paymentStatus;
  }

  const { createdAt, range } = parseDateRange(query);
  if (createdAt) filter.createdAt = createdAt;

  const q = plainString(query, 'q');
  if (q !== undefined) {
    if (q.length > MAX_SEARCH_LENGTH) throw new OrderInputError(`Search can be at most ${MAX_SEARCH_LENGTH} characters`, { q: 'too long' });
    if (q) {
      const literal = escapeRegex(q);
      const contains = new RegExp(literal, 'i');
      filter.$or = [
        // Order numbers are stored upper-case: a case-sensitive prefix match can use the unique index.
        { orderNumber: new RegExp(`^${escapeRegex(q.toUpperCase())}`) },
        { customerName: contains },
        { customerEmail: contains },
        { customerPhone: contains },
      ];
    }
  }
  return { filter, page, limit, range };
}

/** Fields read for list rows (no addresses, item details or payment references). */
export const ORDER_SUMMARY_FIELDS = 'orderNumber createdAt updatedAt status paymentStatus paymentMethod subtotal shipping total customerName customerEmail customerPhone cancelledAt items.quantity';

export function toOrderSummary(o) {
  const items = o.items || [];
  return {
    _id: o._id,
    orderNumber: o.orderNumber ?? null,
    createdAt: o.createdAt ?? null,
    updatedAt: o.updatedAt ?? null,
    status: o.status ?? null,
    paymentStatus: o.paymentStatus ?? null,
    paymentMethod: o.paymentMethod ?? null,
    subtotal: o.subtotal ?? null,
    shipping: o.shipping ?? null,
    total: o.total ?? null,
    itemCount: items.length,
    totalQuantity: items.reduce((sum, i) => sum + (i.quantity || 0), 0),
    customerName: o.customerName ?? null,
    customerEmail: o.customerEmail ?? null,
    customerPhone: o.customerPhone ?? null,
    cancelledAt: o.cancelledAt ?? null,
  };
}

/**
 * Admin order detail: everything needed to manage the order, field by field. Razorpay order/payment
 * ids are references for looking the payment up in the Razorpay dashboard (no signatures or keys are
 * stored). Historical orders without newer fields get explicit nulls rather than invented values.
 */
export function toOrderDetail(o) {
  const customer = o.user && typeof o.user === 'object' && o.user._id
    ? { _id: o.user._id, name: o.user.name ?? null, email: o.user.email ?? null }
    : (o.user ? { _id: o.user, name: null, email: null } : null);
  const r = o.stockReservation;
  return {
    ...toOrderSummary(o),
    items: (o.items || []).map((i) => ({
      product: i.product ?? null,
      title: i.title ?? null,
      image: i.image ?? null,
      unit: i.unit ?? null,
      price: i.price ?? null,
      quantity: i.quantity ?? null,
      lineTotal: typeof i.price === 'number' && typeof i.quantity === 'number' ? Math.round(i.price * i.quantity * 100) / 100 : null,
      variationLabel: i.variationLabel ?? null,
    })),
    customer,
    shippingAddress: o.shippingAddress
      ? Object.fromEntries(['fullName', 'phone', 'line1', 'line2', 'city', 'state', 'pincode'].map((k) => [k, o.shippingAddress[k] ?? null]))
      : null,
    notes: o.notes ?? null,
    cancelledBy: o.cancelledBy ?? null,
    payment: {
      method: o.paymentMethod ?? null,
      status: o.paymentStatus ?? null,
      razorpayOrderId: o.razorpayOrderId ?? null,
      razorpayPaymentId: o.razorpayPaymentId ?? null,
    },
    stockReservation: r?.reservedAt
      ? {
        recorded: true,
        reservedAt: r.reservedAt,
        lines: (r.lines || []).map((l) => ({ product: l.product, quantity: l.quantity })),
        restoredAt: r.restoredAt ?? null,
        missingProducts: r.missingProducts ?? [],
      }
      : { recorded: false },
  };
}
