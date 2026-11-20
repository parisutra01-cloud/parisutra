import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { allocateOrderNumber, isDuplicateOrderNumberError, resyncOrderCounter } from './orderNumber.js';

/** Next order number from the atomic counter (see services/orderNumber.js). */
export function nextOrderNumber() {
  return allocateOrderNumber();
}

export async function buildOrderFromItems(items) {
  const lineItems = [];
  let subtotal = 0;

  for (const item of items) {
    const product = await Product.findById(item.productId);
    if (!product || !product.isActive) {
      throw new Error(`Product unavailable: ${item.productId}`);
    }
    const qty = Math.max(1, Number(item.quantity) || 1);
    if (product.trackStock && product.stock < qty) {
      throw new Error(`Insufficient stock for ${product.title}`);
    }
    const mainImage = product.images?.find((i) => i.isMain)?.url || product.images?.[0]?.url;
    lineItems.push({
      product: product._id,
      title: product.title,
      image: mainImage,
      unit: product.unit,
      price: product.price,
      quantity: qty,
      variationId: item.variationId,
      variationLabel: item.variationLabel,
    });
    subtotal += product.price * qty;
  }

  const shipping = subtotal >= 999 ? 0 : 99;
  const total = subtotal + shipping;
  return { lineItems, subtotal, shipping, total };
}

export async function deductStock(lineItems) {
  for (const line of lineItems) {
    const product = await Product.findById(line.product);
    if (product?.trackStock) {
      product.stock -= line.quantity;
      await product.save();
    }
  }
}

export async function createOrder({
  userId,
  items,
  shippingAddress,
  paymentMethod,
  customerName,
  customerEmail,
  customerPhone,
  paymentStatus = 'pending',
  razorpayOrderId,
  razorpayPaymentId,
}) {
  if (!items?.length) throw new Error('Cart is empty');
  if (!shippingAddress?.line1 || !shippingAddress?.pincode) {
    throw new Error('Complete shipping address is required');
  }

  const { lineItems, subtotal, shipping, total } = await buildOrderFromItems(items);

  const order = await insertOrder({
    user: userId,
    customerName,
    customerEmail,
    customerPhone,
    items: lineItems,
    subtotal,
    shipping,
    total,
    paymentMethod: paymentMethod || 'cod',
    paymentStatus,
    status: 'pending',
    shippingAddress,
    razorpayOrderId,
    razorpayPaymentId,
  });

  // Unchanged for the Razorpay verification path (Phase 5H): see createCodOrder for atomic reservation.
  await deductStock(lineItems);
  return order;
}

/** Inserts an order with a fresh number from the atomic counter (Phase 5B). */
async function insertOrder(fields) {
  for (let attempt = 1; ; attempt += 1) {
    const orderNumber = await nextOrderNumber();
    try {
      return await Order.create({ ...fields, orderNumber });
    } catch (err) {
      // Only possible if the counter fell behind existing data (e.g. orders imported after it was
      // initialised): raise it above the historical maximum and take a fresh number.
      if (isDuplicateOrderNumberError(err) && attempt < 3) {
        await resyncOrderCounter();
        continue;
      }
      throw err;
    }
  }
}

/**
 * Reserves stock for one line with a single conditional update: the decrement only happens if the
 * product is still active, tracks stock and has at least `quantity` units. Field semantics match the
 * Product schema defaults (missing isActive/trackStock = true, missing stock = 0).
 * Returns { reserved: true } when stock was taken, { reserved: false } for untracked products.
 * Failures throw a plain Error (a business-rule message, returned as 400 by routes/orders.js).
 */
export async function reserveLine(productId, quantity) {
  const taken = await Product.updateOne(
    { _id: productId, isActive: { $ne: false }, trackStock: { $ne: false }, stock: { $gte: quantity } },
    { $inc: { stock: -quantity } }
  );
  if (taken.modifiedCount === 1) return { reserved: true };

  const product = await Product.findById(productId).select('title isActive trackStock');
  if (!product || product.isActive === false) throw new Error(`Product unavailable: ${productId}`);
  if (product.trackStock === false) return { reserved: false };
  throw new Error(`Insufficient stock for ${product.title}`);
}

/**
 * Puts back every reservation this checkout made, each exactly once, with atomic $inc (never an
 * absolute value, so concurrent stock changes are preserved). A failed restore is logged with the
 * details needed to fix it by hand and does not stop the remaining restores.
 */
export async function releaseReservations(reservations) {
  const failures = [];
  for (const r of [...reservations].reverse()) {
    if (r.released) continue;
    r.released = true;
    try {
      await Product.updateOne({ _id: r.productId }, { $inc: { stock: r.quantity } });
    } catch (err) {
      failures.push({ productId: String(r.productId), quantity: r.quantity, error: err?.message });
    }
  }
  if (failures.length) {
    console.error('[stock] RESERVATION RELEASE FAILED; restore these quantities manually:', JSON.stringify(failures));
  }
  return failures;
}

/**
 * COD checkout with atomic stock reservation (Phase 5C).
 *
 * `items` are the validated, merged lines from parseCartItems (one line per product).
 * Order: price/snapshot read → reserve every line (conditional $inc) → insert the order.
 * Any failure after the first reservation releases this checkout's reservations, so no order is
 * created and no stock stays deducted. This is compensation, not a transaction: if the process dies
 * between a reservation and its release, that stock stays deducted (logged nowhere; see report).
 *
 * `hooks` exist only for tests (deterministic interleaving); routes never pass them.
 */
export async function createCodOrder({
  userId, items, shippingAddress, customerName, customerEmail, customerPhone,
}, { hooks = {} } = {}) {
  if (!items?.length) throw new Error('Cart is empty');
  if (!shippingAddress?.line1 || !shippingAddress?.pincode) {
    throw new Error('Complete shipping address is required');
  }

  // Prices and snapshots come from the database; this also gives an early, friendly stock error.
  const { lineItems, subtotal, shipping, total } = await buildOrderFromItems(items);

  const reservations = [];
  try {
    await hooks.beforeReserve?.();
    for (const line of lineItems) {
      const { reserved } = await reserveLine(line.product, line.quantity);
      if (reserved) reservations.push({ productId: line.product, quantity: line.quantity, released: false });
      await hooks.afterReserveLine?.(line);
    }
    await hooks.beforeInsert?.();
    return await insertOrder({
      user: userId,
      customerName,
      customerEmail,
      customerPhone,
      items: lineItems,
      subtotal,
      shipping,
      total,
      paymentMethod: 'cod',
      paymentStatus: 'pending',
      status: 'pending',
      shippingAddress,
      // Exactly what this checkout deducted (untracked products are not listed), for 5D restoration.
      stockReservation: {
        reservedAt: new Date(),
        lines: reservations.map((r) => ({ product: r.productId, quantity: r.quantity })),
      },
    });
  } catch (err) {
    await releaseReservations(reservations);
    throw err;
  }
}
