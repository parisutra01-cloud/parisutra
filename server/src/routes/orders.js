import mongoose from 'mongoose';
import { asyncRouter } from '../utils/asyncRouter.js';
import { Order } from '../models/Order.js';
import { User } from '../models/User.js';
import { authRequired, adminRequired } from '../middleware/auth.js';
import { createCodOrder } from '../services/orderService.js';
import { OrderStatusError, cancelOrder, changeOrderStatus } from '../services/orderStatus.js';
import { getDashboardStats } from '../services/orderStats.js';
import { isDatabaseError } from '../middleware/errorHandler.js';
import {
  ORDER_STATUSES, ORDER_SUMMARY_FIELDS, OrderInputError, normalizeEmail, parseDateRange, parseOrderListQuery,
  toOrderDetail, toOrderSummary, optionalText, parseCartItems, parseShippingAddress, parseStatusFilter, parseTrackingQuery, toTrackingView,
} from '../utils/orderInput.js';

const router = asyncRouter();

/** Response for a status change: the order plus what happened to stock. */
function statusResponse(res, { order, changed, stockRestoration }) {
  res.json({ order, changed, stockRestoration: stockRestoration || 'none' });
}

/** Business-rule errors from the status service keep their message; anything else is a 500. */
function statusError(res, next, err) {
  if (err instanceof OrderStatusError) return res.status(err.status).json({ message: err.message });
  return next(err);
}

/** ?recent= for the dashboard: 1–20 recent orders, default 5. */
function parseRecentLimit(value) {
  if (value === undefined || value === '') return 5;
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 20) {
    throw new OrderInputError('recent must be a whole number from 1 to 20', { recent: 'invalid' });
  }
  return Number(value);
}

const inputError = (res, err) => res.status(400).json({ message: err.message, ...(err.errors ? { errors: err.errors } : {}) });

router.post('/', authRequired, async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // The whole cart is validated (and repeated products merged) before any database work.
    const items = parseCartItems(body.items);
    const shippingAddress = parseShippingAddress(body.shippingAddress);
    const customerName = optionalText(body.customerName, 'customerName', 100);
    const customerPhone = optionalText(body.customerPhone, 'customerPhone', 30);

    // The account is the source of truth for the customer's email; a body-supplied email is ignored.
    const account = await User.findById(req.userId).select('email name');
    if (!account) return res.status(401).json({ message: 'Account not found. Please sign in again.' });

    // COD checkout with atomic stock reservation. Paid orders are created only after Razorpay
    // signature verification (routes/payments.js, unchanged).
    const order = await createCodOrder({
      userId: req.userId,
      items,
      shippingAddress,
      customerName: customerName || account.name,
      customerEmail: normalizeEmail(account.email),
      customerPhone,
    });
    res.status(201).json({ order });
  } catch (err) {
    if (err instanceof OrderInputError) return inputError(res, err);
    // Database errors (e.g. duplicate keys) go to the central handler so their internals are never
    // returned to customers; business-rule errors from orderService keep their 400 message.
    console.error(err);
    if (isDatabaseError(err)) return next(err);
    // Only deliberate business-rule errors (plain Error from orderService, e.g. "Insufficient stock")
    // reach the customer; programming errors (TypeError etc.) become a generic 500.
    if (!(err instanceof Error) || err.constructor !== Error) return next(err);
    res.status(400).json({ message: err.message || 'Failed to place order' });
  }
});

// Public: returns only the minimal tracking view (no address, phone, email or payment data).
router.get('/track', async (req, res) => {
  let filter;
  try {
    filter = parseTrackingQuery(req.query);
  } catch (err) {
    if (err instanceof OrderInputError) return inputError(res, err);
    throw err;
  }
  const order = await Order.findOne(filter);
  if (!order) return res.status(404).json({ message: 'Order not found' });
  res.json({ order: toTrackingView(order) });
});

router.get('/my', authRequired, async (req, res) => {
  let status;
  try {
    status = parseStatusFilter(req.query.status);
  } catch (err) {
    return inputError(res, err);
  }
  const filter = { user: req.userId };
  if (status) filter.status = status;
  const orders = await Order.find(filter).sort({ createdAt: -1 });
  res.json({ orders });
});

router.get('/my/:id', authRequired, async (req, res) => {
  const order = await Order.findOne({ _id: req.params.id, user: req.userId });
  if (!order) return res.status(404).json({ message: 'Order not found' });
  res.json({ order });
});

// Customers can cancel only their own pending/processing orders (same rules as admins).
// Repeating the request on an already-cancelled order is a no-op.
router.patch('/my/:id/cancel', authRequired, async (req, res, next) => {
  try {
    statusResponse(res, await cancelOrder({ orderId: req.params.id, actor: 'customer', ownerId: req.userId }));
  } catch (err) {
    statusError(res, next, err);
  }
});

/**
 * Admin order list: page, limit (default 20, max 100), status, paymentStatus, from, to (IST
 * calendar days, inclusive), q (order number prefix, or part of customer name/email/phone).
 * Newest first with _id as tie-breaker; filtering, sorting and paging happen in MongoDB.
 */
router.get('/', authRequired, adminRequired, async (req, res) => {
  let parsed;
  try {
    parsed = parseOrderListQuery(req.query);
  } catch (err) {
    return inputError(res, err);
  }
  const { filter, page, limit } = parsed;
  const [rows, total] = await Promise.all([
    Order.find(filter).select(ORDER_SUMMARY_FIELDS).sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    Order.countDocuments(filter),
  ]);
  const pages = Math.ceil(total / limit);
  res.json({
    orders: rows.map(toOrderSummary),
    pagination: { page, limit, total, pages, hasPrev: page > 1, hasNext: page < pages },
  });
});

/** Admin dashboard statistics (see services/orderStats.js for every metric's definition). */
router.get('/stats', authRequired, adminRequired, async (req, res) => {
  let createdAt;
  let range;
  let recentLimit;
  try {
    ({ createdAt, range } = parseDateRange(req.query));
    recentLimit = parseRecentLimit(req.query.recent);
  } catch (err) {
    return inputError(res, err);
  }
  res.json(await getDashboardStats({ createdAt, range, recentLimit }));
});

/** Admin order detail. Registered after /my and /track so those paths keep their own handlers. */
router.get('/:id', authRequired, adminRequired, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: 'Invalid order id' });
  const order = await Order.findById(req.params.id).populate('user', 'name email').lean();
  if (!order) return res.status(404).json({ message: 'Order not found' });
  res.json({ order: toOrderDetail(order) });
});

router.patch('/:id/status', authRequired, adminRequired, async (req, res, next) => {
  const status = req.body?.status;
  if (typeof status !== 'string' || !ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Invalid order status' });
  }
  try {
    statusResponse(res, await changeOrderStatus({ orderId: req.params.id, to: status, actor: 'admin' }));
  } catch (err) {
    statusError(res, next, err);
  }
});

export default router;
