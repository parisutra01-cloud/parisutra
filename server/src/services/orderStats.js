import { Order } from '../models/Order.js';
import { Product } from '../models/Product.js';
import { Category } from '../models/Category.js';
import { ORDER_STATUSES, ORDER_SUMMARY_FIELDS, toOrderSummary } from '../utils/orderInput.js';

/**
 * Admin dashboard statistics (Milestone 5E). Computed in MongoDB, never cached.
 *
 * Order metrics cover orders created in the optional date range (all time by default):
 *   orders.total            every order
 *   orders.byStatus.<s>     orders whose status is <s> (every status listed, 0 if none)
 *   revenue.paid            sum of `total` where paymentStatus = "paid" AND status ≠ "cancelled"
 *   revenue.paidOrders      count of those orders
 *   revenue.averagePaidOrderValue  revenue.paid / revenue.paidOrders (0 when there are none)
 *   revenue.unpaid          sum of `total` where paymentStatus ≠ "paid" (pending/failed/missing) AND
 *                           status ≠ "cancelled": e.g. COD orders not yet marked paid. Delivered does
 *                           NOT imply paid; payment status is used as stored.
 *   revenue.unpaidOrders    count of those orders
 *   revenue.cancelledPaid   sum of `total` of cancelled orders still marked "paid" (money received
 *                           on orders that were cancelled; refunds are not tracked yet), and its count
 * Catalogue counts are current, not date-filtered:
 *   catalog.activeProducts / totalProducts, catalog.activeCategories / totalCategories
 *   (active = isActive not false, matching the schema default)
 * recentOrders: newest orders in the range, as list summaries, at most `recentLimit`.
 * Amounts are rounded to 2 decimals.
 */
const round2 = (n) => Math.round((n || 0) * 100) / 100;

export async function getDashboardStats({ createdAt, range, recentLimit = 5 } = {}) {
  const match = createdAt ? { createdAt } : {};
  const notCancelled = { $ne: ['$status', 'cancelled'] };
  const isPaid = { $eq: ['$paymentStatus', 'paid'] };
  const total = { $ifNull: ['$total', 0] };

  const [[facets], activeProducts, totalProducts, activeCategories, totalCategories, recent] = await Promise.all([
    Order.aggregate([
      { $match: match },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          money: [{
            $group: {
              _id: null,
              orders: { $sum: 1 },
              paid: { $sum: { $cond: [{ $and: [isPaid, notCancelled] }, total, 0] } },
              paidOrders: { $sum: { $cond: [{ $and: [isPaid, notCancelled] }, 1, 0] } },
              unpaid: { $sum: { $cond: [{ $and: [{ $not: [isPaid] }, notCancelled] }, total, 0] } },
              unpaidOrders: { $sum: { $cond: [{ $and: [{ $not: [isPaid] }, notCancelled] }, 1, 0] } },
              cancelledPaid: { $sum: { $cond: [{ $and: [isPaid, { $not: [notCancelled] }] }, total, 0] } },
              cancelledPaidOrders: { $sum: { $cond: [{ $and: [isPaid, { $not: [notCancelled] }] }, 1, 0] } },
            },
          }],
        },
      },
    ]),
    Product.countDocuments({ isActive: { $ne: false } }),
    Product.countDocuments({}),
    Category.countDocuments({ isActive: { $ne: false } }),
    Category.countDocuments({}),
    Order.find(match).select(ORDER_SUMMARY_FIELDS).sort({ createdAt: -1, _id: -1 }).limit(recentLimit).lean(),
  ]);

  const byStatus = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0]));
  let other = 0;
  for (const row of facets.byStatus) {
    if (row._id in byStatus) byStatus[row._id] = row.count;
    else other += row.count; // documents with a missing/legacy status value
  }
  const m = facets.money[0] || {};
  const paid = round2(m.paid);
  const paidOrders = m.paidOrders || 0;

  return {
    range: range || { from: null, to: null, timezone: 'Asia/Kolkata' },
    orders: { total: m.orders || 0, byStatus, ...(other ? { otherStatus: other } : {}) },
    revenue: {
      currency: 'INR',
      paid,
      paidOrders,
      averagePaidOrderValue: paidOrders ? round2(paid / paidOrders) : 0,
      unpaid: round2(m.unpaid),
      unpaidOrders: m.unpaidOrders || 0,
      cancelledPaid: round2(m.cancelledPaid),
      cancelledPaidOrders: m.cancelledPaidOrders || 0,
    },
    catalog: { activeProducts, totalProducts, activeCategories, totalCategories },
    recentOrders: recent.map(toOrderSummary),
  };
}
