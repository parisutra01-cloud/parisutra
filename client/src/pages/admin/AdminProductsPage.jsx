import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useOutletContext, useSearchParams } from 'react-router-dom';
import AdminIcon from '../../components/admin/AdminIcons.jsx';
import { api } from '../../api/client.js';

const PER_PAGE_OPTIONS = [10, 25, 50];
const SORT_OPTIONS = [
  ['newest', 'Newest first'],
  ['updated', 'Recently updated'],
  ['title-asc', 'Name: A to Z'],
  ['price-asc', 'Price: Low to High'],
  ['price-desc', 'Price: High to Low'],
  ['stock-asc', 'Stock: Low to High'],
  ['stock-desc', 'Stock: High to Low'],
];
const DEFAULTS = { q: '', category: '', status: 'all', stock: 'all', sort: 'newest', page: '1', limit: '10' };
const PLACEHOLDER_IMAGE = '/images/product-1.jpg';

const card = 'bg-white rounded-2xl border border-[#EFE0E4] shadow-[0_2px_10px_rgba(142,24,56,0.03)]';
const selectClass = 'px-3.5 py-2 rounded-xl border border-[#E8D8DC] bg-white text-[12.5px] text-[#4A3439] focus:outline-none focus:border-[#A91D48] cursor-pointer';

function stockLevel(p) {
  if (p.trackStock === false) return 'untracked';
  if ((p.stock ?? 0) <= 0) return 'out';
  if (p.stock <= (p.lowStockAlert ?? 10)) return 'low';
  return 'in';
}

function mainImage(p) {
  return p.images?.find((i) => i.isMain)?.url || p.images?.[0]?.url || PLACEHOLDER_IMAGE;
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function formatPrice(n) {
  return `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef();
  const show = useCallback((message, type = 'success') => {
    clearTimeout(timer.current);
    setToast({ message, type });
    timer.current = setTimeout(() => setToast(null), 4000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [toast, show];
}

export default function AdminProductsPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { globalSearch = '' } = useOutletContext() || {};
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, params.get(k) ?? d])), [params]);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [data, setData] = useState({ products: [], pagination: null, stats: null });
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [toast, showToast] = useToast();
  const isBulkRoute = location.pathname.endsWith('/bulk-upload');

  const updateFilters = useCallback((changes, { resetPage = true } = {}) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries({ ...changes, ...(resetPage ? { page: '1' } : {}) })) {
        if (value === undefined || value === '' || value === DEFAULTS[key]) next.delete(key);
        else next.set(key, String(value));
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  // Flash message after create/update (passed through navigation state), shown once.
  useEffect(() => {
    if (location.state?.flash) {
      showToast(location.state.flash);
      navigate(`${location.pathname}${location.search}`, { replace: true, state: null });
    }
  }, [location.state, location.pathname, location.search, navigate, showToast]);

  // The top-bar search in the admin layout drives this list too.
  useEffect(() => {
    if (globalSearch !== '') setSearchInput(globalSearch);
  }, [globalSearch]);

  // Debounced search → URL (keeps the filter on refresh and back/forward).
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== filters.q) updateFilters({ q: searchInput.trim() });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, filters.q, updateFilters]);

  useEffect(() => {
    api('/categories/manage').then((d) => setCategories(d.categories || [])).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v && v !== 'all') query.set(k, v);
    api(`/products/manage?${query}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load products.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters, reloadKey]);

  const { products, pagination, stats } = data;
  const page = pagination?.page || 1;
  const pages = pagination?.pages || 1;
  const total = pagination?.total || 0;
  const limit = pagination?.limit || Number(filters.limit);
  const hasFilters = ['q', 'category', 'status', 'stock'].some((k) => filters[k] !== DEFAULTS[k]);

  const clearFilters = () => {
    setSearchInput('');
    setParams(new URLSearchParams(filters.limit !== DEFAULTS.limit ? { limit: filters.limit } : {}), { replace: true });
  };

  const handleDelete = async () => {
    const product = confirmDelete;
    setBusyId(product._id);
    try {
      await api(`/products/${product._id}`, { method: 'DELETE' });
      setConfirmDelete(null);
      showToast(`"${product.title}" was removed from the store. You can restore it any time.`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      showToast(err.message || 'Could not delete the product.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async (product) => {
    setBusyId(product._id);
    try {
      await api(`/products/${product._id}`, { method: 'PUT', body: JSON.stringify({ isActive: true }) });
      showToast(`"${product.title}" is visible in the store again.`);
      setReloadKey((k) => k + 1);
    } catch (err) {
      showToast(err.message || 'Could not restore the product.', 'error');
    } finally {
      setBusyId(null);
    }
  };

  const handleExportCsv = async () => {
    setExporting(true);
    try {
      const rows = [];
      const query = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v && v !== 'all' && k !== 'page' && k !== 'limit') query.set(k, v);
      query.set('limit', '100');
      for (let p = 1; p <= 50; p += 1) {
        query.set('page', String(p));
        const d = await api(`/products/manage?${query}`);
        rows.push(...d.products);
        if (p >= d.pagination.pages) break;
      }
      const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const header = ['Title', 'SKU', 'Category', 'Price', 'Unit', 'Stock', 'Status', 'Updated'];
      const lines = rows.map((p) => [p.title, p.sku, p.category?.name, p.price, p.unit, p.stock, p.isActive === false ? 'Inactive' : 'Active', p.updatedAt].map(esc).join(','));
      const blob = new Blob([[header.join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'parisutra-products.csv';
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Exported ${rows.length} product${rows.length === 1 ? '' : 's'} to CSV.`);
    } catch (err) {
      showToast(err.message || 'Export failed.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const kpis = [
    { label: 'Total Products', value: stats?.total, icon: 'box', tone: 'bg-[#FDEBF1] text-[#B82050]' },
    { label: 'Active Listings', value: stats?.active, icon: 'check-circle', tone: 'bg-[#E6F7EE] text-[#1D8852]', onClick: () => updateFilters({ status: 'active' }) },
    { label: 'Low / Out of Stock', value: stats ? `${stats.lowStock} / ${stats.outOfStock}` : undefined, icon: 'warning', tone: 'bg-[#FFF4E4] text-[#D98218]', onClick: () => updateFilters({ stock: 'low' }) },
    { label: 'Inactive (hidden)', value: stats?.inactive, icon: 'eye-off', tone: 'bg-[#F3ECF9] text-[#8244B8]', onClick: () => updateFilters({ status: 'inactive' }) },
  ];

  const pageNumbers = useMemo(() => {
    const set = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
    return [...set].sort((a, b) => a - b);
  }, [page, pages]);

  return (
    <div className="space-y-5">
      {toast && (
        <div role="status" aria-live="polite" data-testid="toast" className={`fixed bottom-6 right-6 z-50 max-w-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2.5 text-[13px] font-medium text-white ${toast.type === 'error' ? 'bg-[#9B1C3A]' : 'bg-[#2C1E21]'}`}>
          <span className={`w-2 h-2 rounded-full shrink-0 ${toast.type === 'error' ? 'bg-[#FFB4C2]' : 'bg-[#249A62]'}`} />
          {toast.message}
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-[#FDF2F5] border border-[#F3DCE2] flex items-center justify-center text-[#A91D48] shrink-0">
            <AdminIcon name="products" size={22} />
          </div>
          <div>
            <h1 className="text-[24px] font-bold text-[#8E1838] leading-tight" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
              Products
            </h1>
            <p className="text-[12.5px] text-[#7A6268] mt-0.5">Manage your catalogue, listings and inventory in one place.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <Link to="/admin/products/new" className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#8E1838] text-white text-[12.5px] font-semibold hover:bg-[#77132E] transition-colors shadow-xs">
            <AdminIcon name="plus" size={15} />
            Add New Product
          </Link>
          <button
            type="button"
            onClick={handleExportCsv}
            disabled={exporting || loading || total === 0}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-[#E6D3D8] text-[#8E1838] text-[12.5px] font-semibold hover:bg-[#FDF5F7] transition-colors shadow-xs cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <AdminIcon name="download" size={15} className="text-[#A91D48]" />
            {exporting ? 'Exporting…' : 'Export CSV'}
          </button>
        </div>
      </div>

      {isBulkRoute && (
        <div className="rounded-xl border border-[#F1D9A6] bg-[#FFF9EC] px-4 py-3 text-[12.5px] text-[#7A5410]">
          Bulk upload from Excel isn&apos;t available yet. Add products one at a time with <Link className="font-semibold underline" to="/admin/products/new">Add New Product</Link>.
        </div>
      )}

      {/* KPI cards (live counts) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
        {kpis.map((k) => (
          <button
            key={k.label}
            type="button"
            onClick={k.onClick}
            disabled={!k.onClick}
            className={`${card} p-4 flex items-center gap-3.5 text-left ${k.onClick ? 'hover:border-[#DCA2B0] cursor-pointer' : 'cursor-default'}`}
          >
            <span className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${k.tone}`}>
              <AdminIcon name={k.icon} size={22} />
            </span>
            <span>
              <span className="block text-[11.5px] font-medium text-[#7A6268]">{k.label}</span>
              <span data-testid={`kpi-${k.label}`} className="block text-[24px] font-bold text-[#2C1E21] leading-none mt-1">{k.value ?? '—'}</span>
            </span>
          </button>
        ))}
      </div>

      {/* Filters + table */}
      <div className={`${card} overflow-hidden`}>
        <div className="p-3.5 border-b border-[#F3E6EA] flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[220px]">
            <AdminIcon name="search" size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9A8187]" />
            <input
              type="search"
              name="q"
              aria-label="Search products"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by name, SKU or URL slug..."
              className="w-full pl-9 pr-3.5 py-2 rounded-xl border border-[#E8D8DC] bg-[#FDFBFC] text-[12.5px] text-[#2C1E21] placeholder-[#9A8187] focus:outline-none focus:border-[#A91D48]"
            />
          </div>
          <select name="category" aria-label="Category" value={filters.category} onChange={(e) => updateFilters({ category: e.target.value })} className={selectClass}>
            <option value="">All categories</option>
            {categories.map((c) => <option key={c._id} value={c._id}>{c.name}{c.isActive === false ? ' (inactive)' : ''}</option>)}
          </select>
          <select name="status" aria-label="Status" value={filters.status} onChange={(e) => updateFilters({ status: e.target.value })} className={selectClass}>
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive (hidden)</option>
          </select>
          <select name="stock" aria-label="Stock level" value={filters.stock} onChange={(e) => updateFilters({ stock: e.target.value })} className={selectClass}>
            <option value="all">All stock levels</option>
            <option value="in">In stock</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
          </select>
          <select name="sort" aria-label="Sort" value={filters.sort} onChange={(e) => updateFilters({ sort: e.target.value })} className={selectClass}>
            {SORT_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
          {hasFilters && (
            <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl border border-[#E8D8DC] bg-[#FDF5F7] text-[#A91D48] text-[12.5px] font-semibold hover:bg-[#FCE8EE] cursor-pointer">
              <AdminIcon name="filter" size={14} />
              Clear filters
            </button>
          )}
        </div>

        <div className="overflow-x-auto" aria-busy={loading}>
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#FDF7F8] border-b border-[#F1E2E6] text-[11.5px] font-bold text-[#4A3439]">
                <th className="py-3 pl-4 px-3">Product / SKU</th>
                <th className="py-3 px-3">Category</th>
                <th className="py-3 px-3">Price</th>
                <th className="py-3 px-3">Stock</th>
                <th className="py-3 px-3">Status</th>
                <th className="py-3 px-3">Last updated</th>
                <th className="py-3 pl-3 pr-4 text-center">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F5EAEC] text-[12px]">
              {loading && products.length === 0 && Array.from({ length: 4 }, (_, i) => (
                <tr key={`sk-${i}`}><td colSpan={7} className="py-4 px-4"><div className="h-8 rounded-lg bg-[#F7EEF0] animate-pulse" /></td></tr>
              ))}
              {!loading && error && (
                <tr>
                  <td colSpan={7} className="py-10 text-center">
                    <p className="text-[#C92A52] font-semibold" role="alert">{error}</p>
                    <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="mt-3 px-4 py-2 rounded-xl border border-[#E6D3D8] text-[#8E1838] text-[12px] font-semibold cursor-pointer">
                      Try again
                    </button>
                  </td>
                </tr>
              )}
              {!error && products.map((p) => {
                const level = stockLevel(p);
                const inactive = p.isActive === false;
                return (
                  <tr key={p._id} data-testid="product-row" data-product-id={p._id} className={`hover:bg-[#FDF9FA] transition-colors ${loading ? 'opacity-60' : ''}`}>
                    <td className="py-3 pl-4 px-3">
                      <div className="flex items-center gap-3">
                        <img src={mainImage(p)} alt="" className="w-10 h-10 rounded-lg object-cover border border-[#EFE0E4] shrink-0 bg-[#FBF7F8]" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                        <div className="min-w-0">
                          <Link to={`/admin/products/${p._id}/edit`} className="font-bold text-[#2C1E21] leading-snug hover:text-[#A91D48] break-words" data-testid="product-title">{p.title}</Link>
                          <p className="text-[11px] text-[#8C7076] mt-0.5">SKU: {p.sku || '—'}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-3">
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-medium bg-[#FDEBF1] text-[#A91D48]">{p.category?.name || 'Missing category'}</span>
                    </td>
                    <td className="py-3 px-3 font-semibold text-[#2C1E21] whitespace-nowrap">{formatPrice(p.price)} / {p.unit}</td>
                    <td className="py-3 px-3 font-bold">
                      <span className={level === 'out' ? 'text-[#C92A52]' : level === 'low' ? 'text-[#D98218]' : 'text-[#1D8852]'}>
                        {p.trackStock === false ? 'Not tracked' : p.stock}
                      </span>
                      {level === 'low' && <span className="ml-1.5 text-[10.5px] font-semibold text-[#D98218]">Low</span>}
                      {level === 'out' && <span className="ml-1.5 text-[10.5px] font-semibold text-[#C92A52]">Out</span>}
                    </td>
                    <td className="py-3 px-3">
                      <span data-testid="product-status" className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-semibold ${inactive ? 'bg-[#F2EFF5] text-[#715888]' : 'bg-[#E2F6EB] text-[#1D8852]'}`}>
                        {inactive ? 'Inactive' : 'Active'}
                      </span>
                    </td>
                    <td className="py-3 px-3 text-[#5E474D] text-[11.5px] whitespace-nowrap">{formatDate(p.updatedAt)}</td>
                    <td className="py-3 pl-3 pr-4">
                      <div className="flex items-center justify-center gap-1.5">
                        <Link to={`/admin/products/${p._id}/edit`} title="Edit product" aria-label={`Edit ${p.title}`} className="w-7 h-7 rounded-lg border border-[#EDE0E3] bg-[#FDF9FA] text-[#A91D48] hover:bg-[#FCE8EE] flex items-center justify-center">
                          <AdminIcon name="edit" size={13.5} />
                        </Link>
                        {inactive ? (
                          <button type="button" onClick={() => handleRestore(p)} disabled={busyId === p._id} title="Restore to store" aria-label={`Restore ${p.title}`} className="w-7 h-7 rounded-lg border border-[#EDE0E3] bg-[#FDF9FA] text-[#1D8852] hover:bg-[#E6F7EE] flex items-center justify-center cursor-pointer disabled:opacity-50">
                            <AdminIcon name="refresh" size={13.5} />
                          </button>
                        ) : (
                          <button type="button" onClick={() => setConfirmDelete(p)} disabled={busyId === p._id} title="Delete product" aria-label={`Delete ${p.title}`} className="w-7 h-7 rounded-lg border border-[#EDE0E3] bg-[#FDF9FA] text-[#7A6268] hover:bg-[#FCE8EE] hover:text-[#C92A52] flex items-center justify-center cursor-pointer disabled:opacity-50">
                            <AdminIcon name="trash" size={13.5} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && !error && products.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-[#8C7076]" data-testid="empty-state">
                    {hasFilters ? (
                      <>No products match your search and filters. <button type="button" onClick={clearFilters} className="font-semibold text-[#A91D48] underline cursor-pointer">Clear filters</button></>
                    ) : (
                      <>No products yet. <Link to="/admin/products/new" className="font-semibold text-[#A91D48] underline">Add your first product</Link>.</>
                    )}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 py-3.5 border-t border-[#F3E6EA] flex flex-col sm:flex-row items-center justify-between gap-3 text-[12px] text-[#6E565C]">
          <span data-testid="pagination-summary">
            {total === 0 ? 'No products' : `Showing ${(page - 1) * limit + 1} – ${Math.min(page * limit, total)} of ${total} products`}
          </span>
          <nav className="flex items-center gap-1.5" aria-label="Pagination">
            <button type="button" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => updateFilters({ page: page - 1 }, { resetPage: false })} className="w-7 h-7 rounded-lg border border-[#E6D6DA] bg-white flex items-center justify-center text-[#6E565C] hover:bg-[#FDF5F7] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
              <AdminIcon name="chevron-right" size={13} className="rotate-180" />
            </button>
            {pageNumbers.map((n, i) => (
              <span key={n} className="flex items-center gap-1.5">
                {i > 0 && n - pageNumbers[i - 1] > 1 && <span className="text-[#8C7076] px-0.5">…</span>}
                <button
                  type="button"
                  aria-current={n === page ? 'page' : undefined}
                  onClick={() => updateFilters({ page: n }, { resetPage: false })}
                  className={`min-w-7 h-7 px-1.5 rounded-lg text-[12px] font-semibold cursor-pointer ${n === page ? 'bg-[#8E1838] text-white' : 'border border-[#E6D6DA] bg-white text-[#4A3439] hover:bg-[#FDF5F7]'}`}
                >
                  {n}
                </button>
              </span>
            ))}
            <button type="button" aria-label="Next page" disabled={page >= pages || loading} onClick={() => updateFilters({ page: page + 1 }, { resetPage: false })} className="w-7 h-7 rounded-lg border border-[#E6D6DA] bg-white flex items-center justify-center text-[#6E565C] hover:bg-[#FDF5F7] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
              <AdminIcon name="chevron-right" size={13} />
            </button>
          </nav>
          <select name="limit" aria-label="Products per page" value={filters.limit} onChange={(e) => updateFilters({ limit: e.target.value })} className="px-3 py-1.5 rounded-lg border border-[#E6D6DA] bg-white text-[12px] text-[#4A3439] focus:outline-none cursor-pointer">
            {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
        </div>
      </div>

      {/* Delete confirmation */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => busyId || setConfirmDelete(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-title" className="bg-white rounded-2xl max-w-md w-full p-6 border border-[#EFE0E4] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 id="delete-title" className="text-[16px] font-bold text-[#8E1838]">Delete “{confirmDelete.title}”?</h3>
            <p className="mt-3 text-[12.5px] text-[#4A3439] leading-relaxed">
              The product will be removed from the store straight away. It stays in this list as <strong>Inactive</strong>, so past
              orders keep their history and you can restore it later.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmDelete(null)} disabled={Boolean(busyId)} className="px-4 py-2 rounded-xl border border-[#E6D6DA] text-[12.5px] font-semibold text-[#4A3439] cursor-pointer">
                Cancel
              </button>
              <button type="button" onClick={handleDelete} disabled={Boolean(busyId)} data-testid="confirm-delete" className="px-4 py-2 rounded-xl bg-[#B4233F] text-white text-[12.5px] font-semibold cursor-pointer disabled:opacity-60">
                {busyId ? 'Deleting…' : 'Delete product'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
