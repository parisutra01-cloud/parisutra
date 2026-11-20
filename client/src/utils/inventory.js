// Inventory display helpers (Phase 5G.4). Status values come from GET /api/products/inventory.

export const STOCK_STATUS = {
  in_stock: { label: 'In stock', badge: 'bg-[#E2F6EB] text-[#1D8852]', text: 'text-[#1D8852]' },
  low_stock: { label: 'Low stock', badge: 'bg-[#FFF4E4] text-[#B86B0E]', text: 'text-[#B86B0E]' },
  out_of_stock: { label: 'Out of stock', badge: 'bg-[#FDE8EC] text-[#C92A52]', text: 'text-[#C92A52]' },
  not_tracked: { label: 'Not tracked', badge: 'bg-[#EEF1F6] text-[#4D5B73]', text: 'text-[#4D5B73]' },
};

/** Same rule as the server (services/inventory.js), used after an adjustment returns new stock. */
export function stockStatusOf({ trackStock, stock, lowStockAlert }) {
  if (trackStock === false) return 'not_tracked';
  const n = typeof stock === 'number' ? stock : 0;
  if (n <= 0) return 'out_of_stock';
  if (n <= (lowStockAlert ?? 10)) return 'low_stock';
  return 'in_stock';
}

export const MAX_STOCK = 10_000_000; // matches server utils/stockInput.js
export const MAX_REASON_LENGTH = 200;

export const formatQty = (n) => Number(n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: 3 });
