import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api/client.js';
import { formatPrice } from '../../utils/format.js';
import { ORDER_STATUSES, STATUS_LABELS, STATUS_STYLES, formatINR, formatDateTime } from '../../utils/adminOrders.js';

/**
 * Admin dashboard. All order figures come from GET /api/orders/stats, which computes them in the
 * database over every order (never from a page of the order list):
 *   paid revenue  = paid AND not cancelled
 *   unpaid value  = not paid (e.g. cash on delivery, even when delivered) AND not cancelled
 */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [products, setProducts] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api('/orders/stats?recent=5')
      .then((d) => { if (!cancelled) setStats(d); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load dashboard statistics.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  useEffect(() => {
    api('/products?limit=6').then((d) => setProducts(d.products || [])).catch(() => setProducts([]));
  }, []);

  const retry = useCallback(() => setReloadKey((k) => k + 1), []);
  const value = (fn) => (stats ? fn(stats) : '—');

  const cards = [
    { label: 'Total Orders', value: value((s) => s.orders.total.toLocaleString('en-IN')), note: 'all time', to: '/admin/orders' },
    { label: 'Paid Revenue', value: value((s) => formatINR(s.revenue.paid)), note: value((s) => `${plural(s.revenue.paidOrders, 'paid order')} · excludes cancelled`) },
    { label: 'Unpaid Order Value', value: value((s) => formatINR(s.revenue.unpaid)), note: value((s) => `${plural(s.revenue.unpaidOrders, 'order')} awaiting payment (incl. COD)`) },
    { label: 'Average Paid Order', value: value((s) => formatINR(s.revenue.averagePaidOrderValue)), note: 'paid, not cancelled' },
    { label: 'Active Products', value: value((s) => s.catalog.activeProducts.toLocaleString('en-IN')), note: value((s) => `${s.catalog.activeCategories} active ${s.catalog.activeCategories === 1 ? 'category' : 'categories'}`), to: '/admin/products' },
  ];

  return (
    <div className="space-y-8" data-testid="dashboard">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-neutral-600">Welcome back! Here&apos;s your store at a glance.</p>
        {stats && !loading && (
          <button type="button" onClick={retry} className="text-sm text-maroon hover:underline">Refresh</button>
        )}
      </div>

      {error && (
        <div role="alert" data-testid="dashboard-error" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
          <p className="font-medium">Dashboard statistics could not be loaded.</p>
          <p className="mt-1">{error}</p>
          <button type="button" onClick={retry} className="mt-3 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-xs font-semibold">
            Try again
          </button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5" aria-busy={loading}>
        {cards.map((card) => {
          const body = (
            <>
              <div className="text-xs uppercase text-neutral-500">{card.label}</div>
              <div className="mt-2 text-2xl font-semibold text-maroon" data-testid={`stat-${card.label}`}>
                {loading ? <span className="inline-block h-7 w-20 animate-pulse rounded bg-neutral-100" /> : card.value}
              </div>
              <div className="mt-1 text-xs text-neutral-500">{loading ? ' ' : card.note}</div>
            </>
          );
          return card.to ? (
            <Link key={card.label} to={card.to} className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card hover:border-maroon/40">{body}</Link>
          ) : (
            <div key={card.label} className="rounded-xl border border-neutral-200 bg-white p-5 shadow-card">{body}</div>
          );
        })}
      </div>

      {stats && (
        <section aria-label="Orders by status" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {ORDER_STATUSES.map((s) => (
            <Link key={s} to={`/admin/orders/${s}`} className="rounded-xl border border-neutral-200 bg-white px-4 py-3 hover:border-maroon/40" data-testid={`status-count-${s}`}>
              <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[s]}`}>{STATUS_LABELS[s]}</span>
              <span className="mt-1 block text-xl font-semibold text-neutral-800">{stats.orders.byStatus[s] ?? 0}</span>
            </Link>
          ))}
        </section>
      )}

      {stats?.revenue.cancelledPaidOrders > 0 && (
        <p className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900" data-testid="cancelled-paid">
          {stats.revenue.cancelledPaidOrders} cancelled order{stats.revenue.cancelledPaidOrders === 1 ? ' is' : 's are'} still marked paid
          ({formatINR(stats.revenue.cancelledPaid)}). This is not counted as revenue; refunds are handled outside this dashboard.
        </p>
      )}

      <div className="grid gap-8 lg:grid-cols-2">
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="mb-4 flex justify-between">
            <h2 className="font-serif text-lg text-maroon">Recent Orders</h2>
            <Link to="/admin/orders" className="text-sm text-maroon">View all</Link>
          </div>
          <ul className="space-y-3 text-sm" data-testid="recent-orders">
            {(stats?.recentOrders || []).map((o) => (
              <li key={o._id} className="flex items-center justify-between gap-3 border-b border-neutral-100 pb-2">
                <Link to={`/admin/orders/${o._id}`} className="min-w-0 hover:text-maroon">
                  <span className="font-medium">#{o.orderNumber || '—'}</span>
                  <span className="ml-2 text-xs text-neutral-500">{formatDateTime(o.createdAt)}</span>
                </Link>
                <span className="flex shrink-0 items-center gap-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${STATUS_STYLES[o.status] || 'bg-neutral-100 text-neutral-600'}`}>
                    {STATUS_LABELS[o.status] || o.status || '—'}
                  </span>
                  <span>{formatINR(o.total)}</span>
                </span>
              </li>
            ))}
            {stats && !stats.recentOrders.length && <li className="text-neutral-500" data-testid="no-orders">No orders yet</li>}
            {loading && !stats && <li className="text-neutral-400">Loading…</li>}
          </ul>
        </section>
        <section className="rounded-xl border border-neutral-200 bg-white p-5">
          <div className="mb-4 flex justify-between">
            <h2 className="font-serif text-lg text-maroon">Products</h2>
            <Link to="/admin/products" className="text-sm text-maroon">Manage</Link>
          </div>
          <ul className="space-y-2 text-sm">
            {products.map((p) => (
              <li key={p._id} className="flex justify-between">
                <span className="truncate pr-4">{p.title}</span>
                <span>{formatPrice(p.price)}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
