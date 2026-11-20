import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import AdminIcon from '../../../components/admin/AdminIcons.jsx';
import { api } from '../../../api/client.js';
import { STOCK_STATUS, formatQty } from '../../../utils/inventory.js';

/*
 * Inventory Reports (Phase 5G.4): a current-stock summary from real data (GET /api/products/inventory).
 * There is no stock movement history yet, so no trends, movement logs or sales-by-product are shown.
 */

const card = 'bg-white rounded-2xl border border-[#EFE0E4] shadow-[0_2px_10px_rgba(142,24,56,0.03)]';
const LIST_SIZE = 8;

function ProductList({ title, testId, filter, items, total, empty }) {
  return (
    <section className={`${card} overflow-hidden`} data-testid={testId}>
      <div className="px-4 py-3 border-b border-[#F3E6EA] flex items-center justify-between gap-3">
        <h2 className="text-[13.5px] font-bold text-[#8E1838]">{title}</h2>
        <Link to={`/admin/products/inventory?stock=${filter}&sort=stock-asc`} className="text-[12px] font-semibold text-[#A91D48] hover:underline whitespace-nowrap">
          View all ({total ?? 0})
        </Link>
      </div>
      {items.length === 0 ? (
        <p className="px-4 py-6 text-[12.5px] text-[#8C7076]">{empty}</p>
      ) : (
        <ul className="divide-y divide-[#F5EAEC] text-[12px]">
          {items.map((p) => (
            <li key={p._id} data-testid="report-row" className="px-4 py-2.5 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Link to={`/admin/products/${p._id}/edit`} className="font-semibold text-[#2C1E21] hover:text-[#A91D48] break-words">{p.title}</Link>
                <p className="text-[11px] text-[#8C7076] break-all">SKU: {p.sku || '—'}{!p.isActive && ' · Inactive'}</p>
              </div>
              <div className="text-right shrink-0">
                <span className={`block font-bold text-[13px] ${STOCK_STATUS[p.stockStatus]?.text || ''}`}>{formatQty(p.stock)} {p.unit}</span>
                <span className="block text-[10.5px] text-[#8C7076]">alert at ≤ {formatQty(p.lowStockAlert)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function AdminInventoryReportsPage() {
  const [state, setState] = useState({ loading: true, error: '', stats: null, low: [], out: [] });

  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: '' }));
    Promise.all([
      api(`/products/inventory?stock=low&sort=stock-asc&limit=${LIST_SIZE}`),
      api(`/products/inventory?stock=out&sort=stock-asc&limit=${LIST_SIZE}`),
    ])
      .then(([low, out]) => setState({ loading: false, error: '', stats: low.stats, low: low.products, out: out.products }))
      .catch((err) => setState((s) => ({ ...s, loading: false, error: err.message || 'Could not load the inventory summary.' })));
  }, []);

  useEffect(() => { load(); }, [load]);

  const { stats } = state;
  const tiles = [
    ['All products', stats?.total, 'all'],
    ['In stock', stats?.inStock, 'in'],
    ['Low stock', stats?.lowStock, 'low'],
    ['Out of stock', stats?.outOfStock, 'out'],
    ['Not tracked', stats?.notTracked, 'untracked'],
  ];

  return (
    <div className="space-y-5" data-testid="inventory-report">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-[#FDF2F5] border border-[#F3DCE2] flex items-center justify-center text-[#A91D48] shrink-0">
          <AdminIcon name="box" size={22} />
        </div>
        <div className="min-w-0">
          <h1 className="text-[22px] sm:text-[24px] font-bold text-[#8E1838] leading-tight" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
            Inventory Reports
          </h1>
          <p className="text-[12.5px] text-[#7A6268] mt-0.5">Current stock summary from live product data.</p>
        </div>
      </div>

      {state.error ? (
        <div className={`${card} p-8 text-center`}>
          <p role="alert" className="text-[12.5px] font-semibold text-[#C92A52]">{state.error}</p>
          <button type="button" onClick={load} className="mt-3 px-4 py-2 rounded-xl border border-[#E6D3D8] text-[#8E1838] text-[12px] font-semibold cursor-pointer">Try again</button>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-3" aria-busy={state.loading}>
            {tiles.map(([label, value, key]) => (
              <Link key={key} to={`/admin/products/inventory${key === 'all' ? '' : `?stock=${key}`}`} className={`${card} p-3.5 hover:border-[#DCA2B0]`}>
                <span className="block text-[11.5px] font-medium text-[#7A6268]">{label}</span>
                <span data-testid={`report-kpi-${key}`} className="block text-[21px] font-bold text-[#2C1E21] leading-none mt-1">{value ?? '—'}</span>
              </Link>
            ))}
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ProductList title="Low stock" testId="report-low" filter="low" items={state.low} total={stats?.lowStock} empty={state.loading ? 'Loading…' : 'No tracked products are at or below their alert level.'} />
            <ProductList title="Out of stock" testId="report-out" filter="out" items={state.out} total={stats?.outOfStock} empty={state.loading ? 'Loading…' : 'No tracked products are out of stock.'} />
          </div>
        </>
      )}

      <section className="rounded-xl border border-[#F1D9A6] bg-[#FFF9EC] px-4 py-3 text-[12.5px] text-[#7A5410]" data-testid="report-not-available">
        <p className="font-semibold">Not available yet</p>
        <p className="mt-1">
          Stock movement history, adjustment logs, stock trends and sales-by-product reports need a stock movement record,
          which isn&apos;t kept yet. Products without stock tracking are counted separately and never as out of stock.
        </p>
      </section>
    </div>
  );
}
