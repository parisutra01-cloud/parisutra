import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import AdminIcon from '../../../components/admin/AdminIcons.jsx';
import { api } from '../../../api/client.js';
import { MAX_REASON_LENGTH, MAX_STOCK, STOCK_STATUS, formatQty, stockStatusOf } from '../../../utils/inventory.js';

/*
 * Inventory / Stock (Phase 5G.4). Real data from GET /api/products/inventory (server-side filters and
 * pagination). Stock changes only through the atomic 5G.2 endpoints:
 *   POST /api/products/:id/stock/adjust { operation: 'add' | 'remove', quantity, reason }
 *   POST /api/products/:id/stock/set    { quantity, expectedStock, reason }  (409 + currentStock if stale)
 */

const PER_PAGE_OPTIONS = [20, 50, 100];
const SORT_OPTIONS = [
  ['title-asc', 'Name: A to Z'],
  ['stock-asc', 'Stock: Low to High'],
  ['stock-desc', 'Stock: High to Low'],
  ['updated', 'Recently updated'],
];
const DEFAULTS = { q: '', stock: 'all', tracking: 'all', status: 'all', sort: 'title-asc', page: '1', limit: '20' };
const PLACEHOLDER_IMAGE = '/images/product-1.jpg';

const card = 'bg-white rounded-2xl border border-[#EFE0E4] shadow-[0_2px_10px_rgba(142,24,56,0.03)]';
const selectClass = 'px-3.5 py-2 rounded-xl border border-[#E8D8DC] bg-white text-[12.5px] text-[#4A3439] focus:outline-none focus:border-[#A91D48] cursor-pointer';
const inputClass = (bad) => `w-full px-3.5 py-2 rounded-xl border bg-[#FDFBFC] text-[13px] text-[#2C1E21] focus:outline-none ${bad ? 'border-[#C92A52]' : 'border-[#E8D8DC] focus:border-[#A91D48]'}`;

function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef();
  const show = useCallback((message, type = 'success') => {
    clearTimeout(timer.current);
    setToast({ message, type });
    timer.current = setTimeout(() => setToast(null), 5000);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [toast, show];
}

function StatusBadge({ status }) {
  const s = STOCK_STATUS[status] || STOCK_STATUS.in_stock;
  return <span data-testid="stock-status" className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-[11px] font-semibold whitespace-nowrap ${s.badge}`}>{s.label}</span>;
}

const MODES = [
  ['add', 'Add stock'],
  ['remove', 'Remove stock'],
  ['set', 'Set exact count'],
];

/** Validates the dialog fields with the same limits as the server (utils/stockInput.js). */
function validateAdjustment({ mode, quantity, reason }) {
  const errors = {};
  const n = Number(quantity);
  const min = mode === 'set' ? 0 : 1;
  if (quantity.trim() === '') errors.quantity = mode === 'set' ? 'Enter the counted quantity' : 'Enter a quantity';
  else if (!Number.isInteger(n) || n < min || n > MAX_STOCK) errors.quantity = `Enter a whole number from ${min} to ${MAX_STOCK.toLocaleString('en-IN')}`;
  const text = reason.trim();
  if (!text) errors.reason = 'A reason is required for every stock change';
  else if (text.length > MAX_REASON_LENGTH) errors.reason = `At most ${MAX_REASON_LENGTH} characters`;
  return errors;
}

function AdjustStockDialog({ product, onClose, onSaved, onStockSeen }) {
  const [mode, setMode] = useState('add');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  // The stock shown when the dialog opened: the exact-count guard (expectedStock). It only changes when
  // the admin explicitly chooses to review a newer value after a conflict.
  const [baseline, setBaseline] = useState(product.stock);
  const [fieldErrors, setFieldErrors] = useState({});
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(null);
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  const dialogRef = useRef(null);
  const quantityRef = useRef(null);

  useEffect(() => { quantityRef.current?.focus(); }, []);

  const close = useCallback(() => { if (!inFlight.current) onClose(); }, [onClose]);

  // Escape closes; Tab stays inside the dialog.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return;
    const focusable = [...dialogRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), [href]')];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };

  const switchMode = (next) => {
    setMode(next);
    setFieldErrors({});
    setError('');
    setConflict(null);
  };

  const n = Number(quantity);
  const validQty = quantity.trim() !== '' && Number.isInteger(n) && n >= 0;
  let preview = null;
  if (validQty) {
    if (mode === 'add') preview = `${formatQty(baseline)} → ${formatQty(baseline + n)}`;
    else if (mode === 'set') preview = `${formatQty(baseline)} → ${formatQty(n)}`;
    else if (baseline - n >= 0) preview = `${formatQty(baseline)} → ${formatQty(baseline - n)}`;
  }
  const removingTooMuch = mode === 'remove' && validQty && baseline - n < 0;
  const submitLabel = mode === 'add'
    ? `Add ${validQty && n > 0 ? formatQty(n) : ''} ${n === 1 ? 'unit' : 'units'}`
    : mode === 'remove'
      ? `Remove ${validQty && n > 0 ? formatQty(n) : ''} ${n === 1 ? 'unit' : 'units'}`
      : `Set stock to ${validQty ? formatQty(n) : '…'}`;

  const submit = async (e) => {
    e.preventDefault();
    if (inFlight.current) return; // no duplicate submissions while a request is pending
    const errs = validateAdjustment({ mode, quantity, reason });
    setFieldErrors(errs);
    if (Object.keys(errs).length) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    setConflict(null);
    const text = reason.trim();
    const [path, body] = mode === 'set'
      ? ['set', { quantity: n, expectedStock: baseline, reason: text }]
      : ['adjust', { operation: mode, quantity: n, reason: text }];
    try {
      const result = await api(`/products/${product._id}/stock/${path}`, { method: 'POST', body: JSON.stringify(body) });
      inFlight.current = false;
      onSaved(product, result, mode);
    } catch (err) {
      inFlight.current = false;
      setPending(false);
      const currentStock = err.data?.currentStock;
      if (err.status === 409 && typeof currentStock === 'number') {
        onStockSeen(product._id, currentStock); // the list shows the authoritative value; nothing is retried
        if (mode === 'set') setConflict({ openedWith: baseline, currentStock });
        else setError(`${err.message}. Current stock: ${formatQty(currentStock)}.`);
        if (mode !== 'set') setBaseline(currentStock);
      } else {
        setError(err.message || 'Could not update the stock. Please try again.');
      }
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center p-4" onClick={close}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="adjust-title"
        data-testid="adjust-dialog"
        onKeyDown={onKeyDown}
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5 sm:p-6 border border-[#EFE0E4] shadow-xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="adjust-title" className="text-[16px] font-bold text-[#8E1838] break-words">Adjust stock</h2>
            <p className="text-[12.5px] text-[#4A3439] font-semibold mt-0.5 break-words">{product.title}</p>
            <p className="text-[11px] text-[#8C7076]">SKU: {product.sku || '—'}</p>
          </div>
          <button type="button" onClick={close} disabled={pending} aria-label="Close" className="w-8 h-8 shrink-0 rounded-lg border border-[#EDE0E3] text-[#7A6268] hover:bg-[#FDF5F7] flex items-center justify-center cursor-pointer disabled:opacity-50">×</button>
        </div>

        <p className="mt-3 text-[12.5px] text-[#4A3439]">
          Current stock: <strong data-testid="dialog-current-stock">{formatQty(baseline)}</strong> {product.unit && <span className="text-[#8C7076]">({product.unit})</span>}
        </p>
        {!product.stockRecorded && <p className="mt-1 text-[11.5px] text-[#8C7076]">No stock value is recorded for this product yet; it counts as 0. Use “Set exact count” to record one.</p>}
        {!product.trackStock && <p className="mt-1 text-[11.5px] text-[#4D5B73]">Stock tracking is off: checkout does not limit this product by stock. Adjusting stock does not turn tracking on.</p>}

        <form onSubmit={submit} noValidate className="mt-4 space-y-3.5">
          <div role="radiogroup" aria-label="Type of change" className="grid grid-cols-3 gap-1.5">
            {MODES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                data-testid={`mode-${value}`}
                disabled={pending}
                onClick={() => switchMode(value)}
                className={`px-2 py-2 rounded-xl text-[12px] font-semibold border cursor-pointer disabled:cursor-not-allowed ${mode === value ? 'bg-[#8E1838] border-[#8E1838] text-white' : 'bg-white border-[#E6D3D8] text-[#4A3439] hover:bg-[#FDF5F7]'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div>
            <label htmlFor="adjust-quantity" className="block text-[12px] font-semibold text-[#4A3439] mb-1.5">
              {mode === 'set' ? 'Counted quantity (new stock)' : mode === 'add' ? 'Quantity to add' : 'Quantity to remove'}
            </label>
            <input
              ref={quantityRef}
              id="adjust-quantity"
              name="quantity"
              type="number"
              inputMode="numeric"
              min={mode === 'set' ? 0 : 1}
              step="1"
              value={quantity}
              disabled={pending}
              onChange={(e) => { setQuantity(e.target.value); setFieldErrors(({ quantity: _, ...r }) => r); }}
              aria-invalid={Boolean(fieldErrors.quantity) || undefined}
              aria-describedby={fieldErrors.quantity ? 'adjust-quantity-error' : undefined}
              className={inputClass(fieldErrors.quantity)}
            />
            {fieldErrors.quantity && <p id="adjust-quantity-error" data-testid="error-quantity" className="mt-1 text-[11px] font-medium text-[#C92A52]">{fieldErrors.quantity}</p>}
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="adjust-reason" className="text-[12px] font-semibold text-[#4A3439]">Reason <span className="text-[#C92A52]">*</span></label>
              <span className="text-[11px] text-[#8C7076]">{reason.length}/{MAX_REASON_LENGTH}</span>
            </div>
            <input
              id="adjust-reason"
              name="reason"
              type="text"
              maxLength={MAX_REASON_LENGTH}
              value={reason}
              disabled={pending}
              placeholder={mode === 'add' ? 'e.g. Delivery from supplier' : mode === 'remove' ? 'e.g. Damaged in storage' : 'e.g. Physical recount'}
              onChange={(e) => { setReason(e.target.value); setFieldErrors(({ reason: _, ...r }) => r); }}
              aria-invalid={Boolean(fieldErrors.reason) || undefined}
              aria-describedby={fieldErrors.reason ? 'adjust-reason-error' : undefined}
              className={inputClass(fieldErrors.reason)}
            />
            {fieldErrors.reason && <p id="adjust-reason-error" data-testid="error-reason" className="mt-1 text-[11px] font-medium text-[#C92A52]">{fieldErrors.reason}</p>}
          </div>

          {preview && <p data-testid="adjust-preview" className="text-[12.5px] text-[#4A3439]">Stock will change: <strong>{preview}</strong></p>}
          {removingTooMuch && <p data-testid="adjust-warning" className="text-[12px] text-[#B86B0E]">That is more than the {formatQty(baseline)} shown. The change will be refused unless stock has gone up since.</p>}
          {mode === 'set' && <p className="text-[11.5px] text-[#7A6268]">The count is saved only if stock is still {formatQty(baseline)}. If a sale or another change happens first, nothing is overwritten.</p>}

          {error && <p role="alert" data-testid="adjust-error" className="rounded-xl border border-[#E9B8C4] bg-[#FDF1F4] px-3.5 py-2.5 text-[12px] text-[#9B1C3A]">{error}</p>}
          {conflict && (
            <div role="alert" data-testid="adjust-conflict" className="rounded-xl border border-[#E9B8C4] bg-[#FDF1F4] p-3.5 text-[12px] text-[#4A3439] space-y-2">
              <p className="font-bold text-[#9B1C3A]">Stock changed since you opened this</p>
              <p>
                It was <strong data-testid="conflict-opened">{formatQty(conflict.openedWith)}</strong> and is now{' '}
                <strong data-testid="conflict-current">{formatQty(conflict.currentStock)}</strong>. Nothing was changed. Review the
                current quantity, then enter the count again.
              </p>
              <button
                type="button"
                data-testid="conflict-review"
                onClick={() => { setBaseline(conflict.currentStock); setConflict(null); setQuantity(''); quantityRef.current?.focus(); }}
                className="px-3 py-1.5 rounded-lg bg-white border border-[#E6D3D8] text-[#8E1838] font-semibold cursor-pointer hover:bg-[#FDF5F7]"
              >
                Review: start from {formatQty(conflict.currentStock)}
              </button>
            </div>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
            <button type="button" onClick={close} disabled={pending} className="px-4 py-2.5 rounded-xl border border-[#E6D6DA] text-[12.5px] font-semibold text-[#4A3439] cursor-pointer disabled:opacity-50">
              Cancel
            </button>
            <button
              type="submit"
              data-testid="adjust-submit"
              disabled={pending || Boolean(conflict)}
              className={`px-4 py-2.5 rounded-xl text-white text-[12.5px] font-semibold cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed ${mode === 'remove' ? 'bg-[#B4233F] hover:bg-[#9B1C3A]' : 'bg-[#8E1838] hover:bg-[#77132E]'}`}
            >
              {pending ? 'Saving…' : submitLabel.replace(/\s+/g, ' ')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AdminInventoryPage() {
  const { globalSearch = '' } = useOutletContext() || {};
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, params.get(k) ?? d])), [params]);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [data, setData] = useState({ products: [], pagination: null, stats: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [adjusting, setAdjusting] = useState(null);
  const [highlight, setHighlight] = useState(null);
  const [toast, showToast] = useToast();
  const returnFocus = useRef(null);

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

  useEffect(() => { if (globalSearch !== '') setSearchInput(globalSearch); }, [globalSearch]);

  // Debounced search → URL (survives refresh and back/forward).
  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== filters.q) updateFilters({ q: searchInput.trim() });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, filters.q, updateFilters]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(filters)) if (v && v !== 'all') query.set(k, v);
    api(`/products/inventory?${query}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load inventory.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [filters, reloadKey]);

  const patchRow = useCallback((id, changes) => {
    setData((d) => ({
      ...d,
      products: d.products.map((p) => {
        if (p._id !== id) return p;
        const next = { ...p, ...changes };
        return { ...next, stockStatus: stockStatusOf(next) };
      }),
    }));
  }, []);

  const openAdjust = (product, e) => {
    returnFocus.current = e.currentTarget;
    setAdjusting(product);
  };
  const closeAdjust = useCallback(() => {
    setAdjusting(null);
    setTimeout(() => returnFocus.current?.focus?.(), 0);
  }, []);

  const onSaved = useCallback((product, result, mode) => {
    // Show the authoritative values returned by the server.
    const p = result.product;
    patchRow(product._id, { stock: p.stock, trackStock: p.trackStock, lowStockAlert: p.lowStockAlert, isActive: p.isActive, stockRecorded: true });
    setHighlight(product._id);
    const verb = mode === 'add' ? 'Added' : mode === 'remove' ? 'Removed' : 'Set';
    const detail = mode === 'set' ? `stock to ${formatQty(p.stock)}` : `${formatQty(Math.abs(result.change))}`;
    showToast(`${verb} ${detail} for “${p.title}”. Stock is now ${formatQty(p.stock)} (was ${formatQty(result.previousStock)}).`);
    closeAdjust();
    // Refresh counts (and filter membership) from the server without losing the shown result.
    setReloadKey((k) => k + 1);
  }, [patchRow, showToast, closeAdjust]);

  const onStockSeen = useCallback((id, currentStock) => patchRow(id, { stock: currentStock, stockRecorded: true }), [patchRow]);

  const { products, pagination, stats } = data;
  const page = pagination?.page || 1;
  const pages = pagination?.pages || 1;
  const total = pagination?.total || 0;
  const limit = pagination?.limit || Number(filters.limit);
  const hasFilters = ['q', 'stock', 'tracking', 'status'].some((k) => filters[k] !== DEFAULTS[k]);

  const clearFilters = () => {
    setSearchInput('');
    setParams(new URLSearchParams(filters.limit !== DEFAULTS.limit ? { limit: filters.limit } : {}), { replace: true });
  };

  const kpis = [
    { key: 'all', label: 'All products', value: stats?.total, tone: 'bg-[#FDEBF1] text-[#B82050]', icon: 'box' },
    { key: 'in', label: 'In stock', value: stats?.inStock, tone: 'bg-[#E6F7EE] text-[#1D8852]', icon: 'check-circle' },
    { key: 'low', label: 'Low stock', value: stats?.lowStock, tone: 'bg-[#FFF4E4] text-[#D98218]', icon: 'warning' },
    { key: 'out', label: 'Out of stock', value: stats?.outOfStock, tone: 'bg-[#FDE8EC] text-[#C92A52]', icon: 'warning' },
    { key: 'untracked', label: 'Not tracked', value: stats?.notTracked, tone: 'bg-[#EEF1F6] text-[#4D5B73]', icon: 'eye-off' },
  ];

  const pageNumbers = useMemo(() => {
    const set = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages));
    return [...set].sort((a, b) => a - b);
  }, [page, pages]);

  return (
    <div className="space-y-5" data-testid="inventory-page">
      {toast && (
        <div role="status" aria-live="polite" data-testid="toast" className={`fixed bottom-6 left-4 right-4 sm:left-auto sm:right-6 z-[60] sm:max-w-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2.5 text-[13px] font-medium text-white ${toast.type === 'error' ? 'bg-[#9B1C3A]' : 'bg-[#2C1E21]'}`}>
          <span className={`w-2 h-2 rounded-full shrink-0 ${toast.type === 'error' ? 'bg-[#FFB4C2]' : 'bg-[#249A62]'}`} />
          {toast.message}
        </div>
      )}

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-[#FDF2F5] border border-[#F3DCE2] flex items-center justify-center text-[#A91D48] shrink-0">
            <AdminIcon name="box" size={22} />
          </div>
          <div className="min-w-0">
            <h1 className="text-[22px] sm:text-[24px] font-bold text-[#8E1838] leading-tight" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
              Inventory / Stock
            </h1>
            <p className="text-[12.5px] text-[#7A6268] mt-0.5">Live stock levels. Every change needs a reason and is applied safely alongside orders.</p>
          </div>
        </div>
        <Link to="/admin/products" className="self-start sm:self-auto inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-[#E6D3D8] text-[#8E1838] text-[12.5px] font-semibold hover:bg-[#FDF5F7]">
          <AdminIcon name="products" size={15} className="text-[#A91D48]" />
          Manage products
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {kpis.map((k) => (
          <button
            key={k.key}
            type="button"
            onClick={() => updateFilters({ stock: k.key })}
            aria-pressed={filters.stock === k.key}
            className={`${card} p-3.5 flex items-center gap-3 text-left cursor-pointer hover:border-[#DCA2B0] min-w-0 ${filters.stock === k.key ? 'ring-2 ring-[#DCA2B0]' : ''}`}
          >
            <span className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${k.tone}`}><AdminIcon name={k.icon} size={19} /></span>
            <span className="min-w-0">
              <span className="block text-[11.5px] font-medium text-[#7A6268] truncate">{k.label}</span>
              <span data-testid={`kpi-${k.key}`} className="block text-[21px] font-bold text-[#2C1E21] leading-none mt-1">{k.value ?? '—'}</span>
            </span>
          </button>
        ))}
      </div>

      <div className={`${card} overflow-hidden`}>
        <div className="p-3.5 border-b border-[#F3E6EA] flex flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[200px] basis-full sm:basis-auto">
            <AdminIcon name="search" size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9A8187]" />
            <input
              type="search"
              name="q"
              aria-label="Search inventory by product name or SKU"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search by product name or SKU..."
              className="w-full pl-9 pr-3.5 py-2 rounded-xl border border-[#E8D8DC] bg-[#FDFBFC] text-[12.5px] text-[#2C1E21] placeholder-[#9A8187] focus:outline-none focus:border-[#A91D48]"
            />
          </div>
          <select name="stock" aria-label="Stock status" value={filters.stock} onChange={(e) => updateFilters({ stock: e.target.value })} className={selectClass}>
            <option value="all">All stock statuses</option>
            <option value="in">In stock</option>
            <option value="low">Low stock</option>
            <option value="out">Out of stock</option>
            <option value="untracked">Not tracked</option>
          </select>
          <select name="tracking" aria-label="Stock tracking" value={filters.tracking} onChange={(e) => updateFilters({ tracking: e.target.value })} className={selectClass}>
            <option value="all">Tracked and not tracked</option>
            <option value="tracked">Stock tracked</option>
            <option value="untracked">Stock not tracked</option>
          </select>
          <select name="status" aria-label="Product status" value={filters.status} onChange={(e) => updateFilters({ status: e.target.value })} className={selectClass}>
            <option value="all">Active and inactive</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive (hidden)</option>
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

        <div aria-busy={loading} data-testid="inventory-list">
          <div className="hidden md:grid md:grid-cols-[minmax(0,2.6fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1fr)_auto] gap-3 px-4 py-3 bg-[#FDF7F8] border-b border-[#F1E2E6] text-[11.5px] font-bold text-[#4A3439]">
            <span>Product / SKU</span>
            <span>Stock</span>
            <span>Low-stock alert</span>
            <span>Status</span>
            <span>Tracking</span>
            <span className="w-[92px] text-center">Actions</span>
          </div>

          {loading && products.length === 0 && !error && (
            <div data-testid="inventory-loading" className="p-4 space-y-3">
              {Array.from({ length: 4 }, (_, i) => <div key={i} className="h-10 rounded-lg bg-[#F7EEF0] animate-pulse" />)}
              <p className="sr-only">Loading inventory…</p>
            </div>
          )}

          {!loading && error && (
            <div className="py-10 px-4 text-center" data-testid="inventory-error">
              <p className="text-[#C92A52] font-semibold text-[12.5px]" role="alert">{error}</p>
              <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="mt-3 px-4 py-2 rounded-xl border border-[#E6D3D8] text-[#8E1838] text-[12px] font-semibold cursor-pointer">
                Try again
              </button>
            </div>
          )}

          {!error && (
            <ul className="divide-y divide-[#F5EAEC] text-[12px]">
              {products.map((p) => (
                <li
                  key={p._id}
                  data-testid="inventory-row"
                  data-product-id={p._id}
                  className={`px-4 py-3 grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 md:grid-cols-[minmax(0,2.6fr)_minmax(0,0.9fr)_minmax(0,0.9fr)_minmax(0,1.1fr)_minmax(0,1fr)_auto] md:items-center transition-colors ${highlight === p._id ? 'bg-[#FFFBEA]' : 'hover:bg-[#FDF9FA]'} ${loading ? 'opacity-60' : ''}`}
                >
                  <div className="flex items-center gap-3 min-w-0 col-span-2 md:col-span-1">
                    <img src={p.image || PLACEHOLDER_IMAGE} alt="" className="w-10 h-10 rounded-lg object-cover border border-[#EFE0E4] shrink-0 bg-[#FBF7F8]" onError={(e) => { e.currentTarget.style.visibility = 'hidden'; }} />
                    <div className="min-w-0">
                      <Link to={`/admin/products/${p._id}/edit`} data-testid="inventory-title" className="font-bold text-[#2C1E21] leading-snug hover:text-[#A91D48] break-words">{p.title}</Link>
                      <p className="text-[11px] text-[#8C7076] mt-0.5 break-all">
                        SKU: <span data-testid="inventory-sku">{p.sku || '—'}</span>
                        {p.category?.name && <span className="text-[#A6939A]"> · {p.category.name}</span>}
                        {!p.isActive && <span data-testid="inactive-badge" className="ml-1.5 inline-flex px-1.5 py-px rounded bg-[#F2EFF5] text-[#715888] text-[10.5px] font-semibold">Inactive</span>}
                      </p>
                    </div>
                  </div>

                  <div className="md:block">
                    <span className="md:hidden text-[11px] text-[#8C7076] mr-1">Stock:</span>
                    <span data-testid="inventory-stock" className={`font-bold text-[14px] ${STOCK_STATUS[p.stockStatus]?.text || ''}`}>{formatQty(p.stock)}</span>
                    <span className="text-[11px] text-[#8C7076] ml-1">{p.unit}</span>
                    {!p.stockRecorded && <span className="block text-[10.5px] text-[#8C7076]">no value recorded</span>}
                  </div>
                  <div className="text-right md:text-left">
                    <span className="md:hidden text-[11px] text-[#8C7076] mr-1">Alert at:</span>
                    <span data-testid="inventory-alert" className="font-semibold text-[#4A3439]">{p.trackStock ? `≤ ${formatQty(p.lowStockAlert)}` : '—'}</span>
                  </div>
                  <div><StatusBadge status={p.stockStatus} /></div>
                  <div className="text-right md:text-left">
                    <span data-testid="inventory-tracking" className={`text-[11.5px] font-semibold ${p.trackStock ? 'text-[#1D8852]' : 'text-[#4D5B73]'}`}>
                      {p.trackStock ? 'Tracked' : 'Not tracked'}
                    </span>
                  </div>
                  <div className="col-span-2 md:col-span-1 md:w-[92px] flex md:justify-center">
                    <button
                      type="button"
                      data-testid="adjust-button"
                      onClick={(e) => openAdjust(p, e)}
                      aria-label={`Adjust stock for ${p.title}`}
                      className="w-full md:w-auto inline-flex items-center justify-center gap-1.5 px-3 py-2 md:py-1.5 rounded-lg border border-[#E6D3D8] bg-[#FDF9FA] text-[#8E1838] text-[12px] font-semibold hover:bg-[#FCE8EE] cursor-pointer"
                    >
                      <AdminIcon name="edit" size={13} />
                      Adjust
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          {!loading && !error && products.length === 0 && (
            <div className="py-12 px-4 text-center text-[12.5px] text-[#8C7076]" data-testid="empty-state">
              {hasFilters ? (
                <>No products match your search and filters. <button type="button" onClick={clearFilters} className="font-semibold text-[#A91D48] underline cursor-pointer">Clear filters</button></>
              ) : (
                <>No products yet. <Link to="/admin/products/new" className="font-semibold text-[#A91D48] underline">Add your first product</Link>.</>
              )}
            </div>
          )}
        </div>

        <div className="px-4 py-3.5 border-t border-[#F3E6EA] flex flex-col sm:flex-row items-center justify-between gap-3 text-[12px] text-[#6E565C]">
          <span data-testid="pagination-summary">
            {total === 0 ? 'No products' : `Showing ${(page - 1) * limit + 1} – ${Math.min(page * limit, total)} of ${total} products`}
          </span>
          <nav className="flex flex-wrap items-center justify-center gap-1.5" aria-label="Pagination">
            <button type="button" aria-label="Previous page" disabled={page <= 1 || loading} onClick={() => updateFilters({ page: page - 1 }, { resetPage: false })} className="w-8 h-8 rounded-lg border border-[#E6D6DA] bg-white flex items-center justify-center text-[#6E565C] hover:bg-[#FDF5F7] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
              <AdminIcon name="chevron-right" size={13} className="rotate-180" />
            </button>
            {pageNumbers.map((n, i) => (
              <span key={n} className="flex items-center gap-1.5">
                {i > 0 && n - pageNumbers[i - 1] > 1 && <span className="text-[#8C7076] px-0.5">…</span>}
                <button
                  type="button"
                  aria-current={n === page ? 'page' : undefined}
                  onClick={() => updateFilters({ page: n }, { resetPage: false })}
                  className={`min-w-8 h-8 px-1.5 rounded-lg text-[12px] font-semibold cursor-pointer ${n === page ? 'bg-[#8E1838] text-white' : 'border border-[#E6D6DA] bg-white text-[#4A3439] hover:bg-[#FDF5F7]'}`}
                >
                  {n}
                </button>
              </span>
            ))}
            <button type="button" aria-label="Next page" disabled={page >= pages || loading} onClick={() => updateFilters({ page: page + 1 }, { resetPage: false })} className="w-8 h-8 rounded-lg border border-[#E6D6DA] bg-white flex items-center justify-center text-[#6E565C] hover:bg-[#FDF5F7] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed">
              <AdminIcon name="chevron-right" size={13} />
            </button>
          </nav>
          <select name="limit" aria-label="Products per page" value={filters.limit} onChange={(e) => updateFilters({ limit: e.target.value })} className="px-3 py-1.5 rounded-lg border border-[#E6D6DA] bg-white text-[12px] text-[#4A3439] focus:outline-none cursor-pointer">
            {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
          </select>
        </div>
      </div>

      {adjusting && <AdjustStockDialog key={adjusting._id} product={adjusting} onClose={closeAdjust} onSaved={onSaved} onStockSeen={onStockSeen} />}
    </div>
  );
}
