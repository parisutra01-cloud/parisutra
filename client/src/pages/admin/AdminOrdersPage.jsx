import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import AdminIcon from '../../components/admin/AdminIcons.jsx';
import { api } from '../../api/client.js';
import {
  ORDER_STATUSES, PAYMENT_LABELS, PAYMENT_STATUSES, PAYMENT_STYLES, STATUS_LABELS, STATUS_STYLES,
  formatDateTime, formatINR, textOr,
} from '../../utils/adminOrders.js';

/**
 * Admin order list (Phase 5F), backed by GET /api/orders: server-side pagination, search and
 * filters, all kept in the URL. The status routes (/admin/orders/pending, …) render this page with a
 * fixed status (App.jsx gives each route its own key, so switching routes starts with fresh state).
 * Status counts come from GET /api/orders/stats (all time).
 */
const PER_PAGE_OPTIONS = [20, 50, 100];
const DEFAULTS = { q: '', status: '', paymentStatus: '', from: '', to: '', page: '1', limit: '20' };
const FILTER_KEYS = ['q', 'status', 'paymentStatus', 'from', 'to'];
const card = 'bg-white rounded-xl border border-[#F2E2E6] shadow-2xs';
const selectClass = 'px-3 py-2 rounded-lg border border-[#E6D3D9] bg-white text-[12.5px] text-[#1E3A5F] focus:outline-none focus:border-[#B8294B] cursor-pointer';

function Badge({ children, className }) {
  return <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${className}`}>{children}</span>;
}

function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export default function AdminOrdersPage({ presetStatus = '' }) {
  const { globalSearch = '' } = useOutletContext() || {};
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => {
    const f = Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, params.get(k) ?? d]));
    if (presetStatus) f.status = presetStatus;
    return f;
  }, [params, presetStatus]);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [data, setData] = useState({ orders: [], pagination: null });
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState('');
  const noticeTimer = useRef();

  const showNotice = useCallback((msg) => {
    clearTimeout(noticeTimer.current);
    setNotice(msg);
    noticeTimer.current = setTimeout(() => setNotice(''), 4000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  /** Any filter change resets to page 1; empty/default values are removed from the URL. */
  const updateFilters = useCallback((changes, { resetPage = true } = {}) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries({ ...changes, ...(resetPage ? { page: '1' } : {}) })) {
        if (value === undefined || value === '' || value === DEFAULTS[key]) next.delete(key);
        else next.set(key, String(value));
      }
      if (presetStatus) next.delete('status');
      return next;
    }, { replace: true });
  }, [setParams, presetStatus]);

  useEffect(() => { if (globalSearch !== '') setSearchInput(globalSearch); }, [globalSearch]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== filters.q) updateFilters({ q: searchInput.trim() });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, filters.q, updateFilters]);

  const listQuery = useMemo(() => {
    const q = new URLSearchParams();
    for (const key of [...FILTER_KEYS, 'page', 'limit']) if (filters[key]) q.set(key, filters[key]);
    return q.toString();
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api(`/orders?${listQuery}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load orders.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [listQuery, reloadKey]);

  useEffect(() => {
    api('/orders/stats?recent=1').then(setStats).catch(() => setStats(null));
  }, [reloadKey]);

  const { orders, pagination } = data;
  const page = pagination?.page || Number(filters.page);
  const pages = pagination?.pages || 0;
  const total = pagination?.total || 0;
  const limit = pagination?.limit || Number(filters.limit);
  const hasFilters = FILTER_KEYS.some((k) => k !== 'status' && filters[k]) || (!presetStatus && filters.status);
  const title = presetStatus ? `${STATUS_LABELS[presetStatus]} Orders` : 'Orders';

  const clearFilters = () => {
    setSearchInput('');
    updateFilters({ q: '', paymentStatus: '', from: '', to: '', ...(presetStatus ? {} : { status: '' }) });
  };

  /** Exports every order matching the current filters (fetched 100 at a time from the API). */
  const exportCsv = async () => {
    setExporting(true);
    try {
      const rows = [];
      const base = new URLSearchParams(listQuery);
      base.set('limit', '100');
      for (let p = 1; p <= 100; p += 1) {
        base.set('page', String(p));
        const d = await api(`/orders?${base}`);
        rows.push(...d.orders);
        if (!d.pagination.hasNext) break;
      }
      const header = ['Order number', 'Date (IST)', 'Customer', 'Email', 'Phone', 'Items', 'Quantity', 'Total (INR)', 'Status', 'Payment status', 'Payment method'];
      const lines = rows.map((o) => [o.orderNumber, formatDateTime(o.createdAt), o.customerName, o.customerEmail, o.customerPhone, o.itemCount, o.totalQuantity, o.total, o.status, o.paymentStatus, o.paymentMethod].map(csvCell).join(','));
      const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `parisutra-orders${presetStatus ? `-${presetStatus}` : ''}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      showNotice(`Exported ${rows.length} order${rows.length === 1 ? '' : 's'}.`);
    } catch (err) {
      showNotice(err.message || 'Export failed.');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="text-[#1E3A5F]" data-testid="orders-page">
      {notice && (
        <div role="status" data-testid="toast" className="fixed bottom-5 right-5 z-50 rounded-xl bg-[#1E3A5F] px-4 py-2.5 text-xs font-semibold text-white shadow-lg">
          {notice}
        </div>
      )}

      <div className="flex items-center gap-1.5 text-[12px] text-[#4A6B8C] mb-3">
        <Link to="/admin/orders" className="hover:text-[#B8294B] transition-colors">Orders</Link>
        <AdminIcon name="chevron-right" size={12} className="text-[#7A93AC]" />
        <span className="text-[#1E3A5F] font-medium">{presetStatus ? STATUS_LABELS[presetStatus] : 'All Orders'}</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-lg bg-[#FDF2F4] border border-[#F3D8DF] flex items-center justify-center text-[#D14B6E] shrink-0 mt-0.5">
            <AdminIcon name="orders" size={20} strokeWidth={1.8} />
          </div>
          <div>
            <h1 className="text-[24px] font-bold text-[#B8294B] leading-tight" style={{ fontFamily: 'Georgia, serif' }} data-testid="orders-title">
              {title}
            </h1>
            <p className="text-[12.5px] text-[#4A6B8C] mt-0.5">
              Search, filter and open <span className="font-semibold text-[#1E3A5F]">customer orders</span>. Dates are in India time (IST).
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="inline-flex items-center gap-2 bg-white hover:bg-[#FDF2F4] text-[#1E3A5F] border border-[#E6D3D9] text-[12.5px] font-semibold px-3 py-2.5 rounded-lg cursor-pointer">
            <AdminIcon name="refresh" size={15} />
            <span>Refresh</span>
          </button>
          <button type="button" onClick={exportCsv} disabled={exporting || !total} className="inline-flex items-center gap-2 bg-white hover:bg-[#FDF2F4] text-[#B8294B] border border-[#E5B8C5] text-[12.5px] font-semibold px-4 py-2.5 rounded-lg cursor-pointer disabled:opacity-50 disabled:cursor-default">
            <AdminIcon name="download" size={15} />
            <span>{exporting ? 'Exporting…' : 'Export CSV'}</span>
          </button>
        </div>
      </div>

      {/* Status counts (all time) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-4">
        {['', ...ORDER_STATUSES].map((s) => {
          const active = (presetStatus || filters.status) === s;
          const count = stats ? (s ? stats.orders.byStatus[s] : stats.orders.total) : null;
          return (
            <Link
              key={s || 'all'}
              to={s ? `/admin/orders/${s}` : '/admin/orders'}
              data-testid={`count-${s || 'all'}`}
              className={`${card} p-3 flex flex-col gap-1 transition-colors ${active ? 'border-[#B8294B] ring-1 ring-[#B8294B]/30' : 'hover:border-[#D4A3B0]'}`}
            >
              <span className="text-[10.5px] text-[#4A6B8C] font-medium">{s ? STATUS_LABELS[s] : 'All orders'}</span>
              <span className="text-[19px] font-bold text-[#142C4C] leading-none">{count ?? '—'}</span>
            </Link>
          );
        })}
      </div>

      <div className={`${card} overflow-hidden`}>
        <div className="p-3 border-b border-[#F3E6EA] flex flex-wrap items-end gap-2.5">
          <label className="relative flex-1 min-w-[200px]">
            <span className="sr-only">Search orders</span>
            <AdminIcon name="search" size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7A93AC]" />
            <input
              type="search"
              aria-label="Search orders"
              value={searchInput}
              maxLength={100}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Order number, customer name, email or phone…"
              className="w-full pl-9 pr-3 py-2 rounded-lg border border-[#E6D3D9] bg-[#FDFBFC] text-[12.5px] focus:outline-none focus:border-[#B8294B]"
            />
          </label>
          {!presetStatus && (
            <select aria-label="Status" value={filters.status} onChange={(e) => updateFilters({ status: e.target.value })} className={selectClass}>
              <option value="">All statuses</option>
              {ORDER_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          )}
          <select aria-label="Payment status" value={filters.paymentStatus} onChange={(e) => updateFilters({ paymentStatus: e.target.value })} className={selectClass}>
            <option value="">All payments</option>
            {PAYMENT_STATUSES.map((s) => <option key={s} value={s}>{PAYMENT_LABELS[s]}</option>)}
          </select>
          <label className="flex flex-col text-[10.5px] text-[#4A6B8C]">
            From (IST)
            <input type="date" aria-label="From date" value={filters.from} max={filters.to || undefined} onChange={(e) => updateFilters({ from: e.target.value })} className={selectClass} />
          </label>
          <label className="flex flex-col text-[10.5px] text-[#4A6B8C]">
            To (IST)
            <input type="date" aria-label="To date" value={filters.to} min={filters.from || undefined} onChange={(e) => updateFilters({ to: e.target.value })} className={selectClass} />
          </label>
          {hasFilters && (
            <button type="button" onClick={clearFilters} data-testid="clear-filters" className="text-[12px] font-semibold text-[#B8294B] hover:underline cursor-pointer pb-2">
              Clear filters
            </button>
          )}
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-[760px]">
            <thead>
              <tr className="bg-[#FBF5F7] border-b border-[#F1E2E6] text-[11.5px] font-bold text-[#1E3A5F]">
                <th className="py-3 pl-4 pr-3">Order</th>
                <th className="py-3 px-3">Date (IST)</th>
                <th className="py-3 px-3">Customer</th>
                <th className="py-3 px-3">Items</th>
                <th className="py-3 px-3 text-right">Total</th>
                <th className="py-3 px-3">Payment</th>
                <th className="py-3 pl-3 pr-4">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F5EAEC] text-[12.5px]" aria-busy={loading}>
              {loading && Array.from({ length: 5 }).map((_, i) => (
                <tr key={`s${i}`} aria-hidden="true"><td colSpan={7} className="py-3 px-4"><div className="h-8 rounded-lg bg-[#F7EEF1] animate-pulse" /></td></tr>
              ))}

              {!loading && error && (
                <tr>
                  <td colSpan={7} className="py-10 text-center" data-testid="orders-error">
                    <p className="text-[13px] font-semibold text-[#B4233F]">Could not load orders</p>
                    <p className="text-[12px] text-[#4A6B8C] mt-1">{error}</p>
                    <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="mt-3 px-4 py-2 rounded-lg border border-[#E6D3D9] text-[12px] font-semibold text-[#B8294B] cursor-pointer">
                      Try again
                    </button>
                  </td>
                </tr>
              )}

              {!loading && !error && orders.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#4A6B8C]" data-testid="empty-state">
                    {hasFilters ? 'No orders match these filters.' : presetStatus ? `No ${STATUS_LABELS[presetStatus].toLowerCase()} orders.` : 'No orders yet.'}
                  </td>
                </tr>
              )}

              {!loading && !error && orders.map((o) => (
                <tr key={o._id} data-testid="order-row" className="hover:bg-[#FDF9FA] transition-colors">
                  <td className="py-3 pl-4 pr-3">
                    <Link to={`/admin/orders/${o._id}`} data-testid="order-number" className="font-bold text-[#B8294B] hover:underline">
                      #{textOr(o.orderNumber)}
                    </Link>
                  </td>
                  <td className="py-3 px-3 text-[#4A6B8C] whitespace-nowrap">{formatDateTime(o.createdAt)}</td>
                  <td className="py-3 px-3">
                    <p className="font-semibold text-[#142C4C]">{textOr(o.customerName)}</p>
                    <p className="text-[11px] text-[#6C849D]">{textOr(o.customerEmail, '')}{o.customerPhone ? ` · ${o.customerPhone}` : ''}</p>
                  </td>
                  <td className="py-3 px-3 text-[#4A6B8C]">{o.itemCount} item{o.itemCount === 1 ? '' : 's'} · qty {o.totalQuantity}</td>
                  <td className="py-3 px-3 text-right font-semibold whitespace-nowrap">{formatINR(o.total)}</td>
                  <td className="py-3 px-3">
                    <Badge className={PAYMENT_STYLES[o.paymentStatus] || 'bg-neutral-100 text-neutral-600'}>{PAYMENT_LABELS[o.paymentStatus] || textOr(o.paymentStatus)}</Badge>
                    <span className="ml-1.5 text-[11px] text-[#6C849D] uppercase">{textOr(o.paymentMethod, '')}</span>
                  </td>
                  <td className="py-3 pl-3 pr-4">
                    <Badge className={STATUS_STYLES[o.status] || 'bg-neutral-100 text-neutral-600'}>
                      <span data-testid="order-status">{STATUS_LABELS[o.status] || textOr(o.status)}</span>
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-4 py-3.5 border-t border-[#F3E6EA] flex flex-col sm:flex-row items-center justify-between gap-3 text-[12px] text-[#4A6B8C]">
          <span data-testid="pagination-summary">
            {total ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${total} order${total === 1 ? '' : 's'}` : 'No orders'}
          </span>
          <div className="flex items-center gap-1.5">
            <button type="button" aria-label="Previous page" disabled={!pagination?.hasPrev || loading} onClick={() => updateFilters({ page: page - 1 }, { resetPage: false })} className="w-7 h-7 rounded-lg border border-[#E6D3D9] bg-white flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-default">
              <AdminIcon name="chevron-right" size={13} className="rotate-180" />
            </button>
            <span className="px-2 font-semibold text-[#1E3A5F]" data-testid="page-info">Page {pages ? page : 0} of {pages}</span>
            <button type="button" aria-label="Next page" disabled={!pagination?.hasNext || loading} onClick={() => updateFilters({ page: page + 1 }, { resetPage: false })} className="w-7 h-7 rounded-lg border border-[#E6D3D9] bg-white flex items-center justify-center cursor-pointer disabled:opacity-40 disabled:cursor-default">
              <AdminIcon name="chevron-right" size={13} />
            </button>
          </div>
          <select aria-label="Per page" value={filters.limit} onChange={(e) => updateFilters({ limit: e.target.value })} className={selectClass}>
            {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
        </div>
      </div>
    </div>
  );
}
