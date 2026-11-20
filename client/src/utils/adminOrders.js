/**
 * Shared helpers for the admin order screens (Phase 5F).
 *
 * ORDER_TRANSITIONS mirrors server/src/services/orderStatus.js so the UI only offers moves the API
 * accepts. The server remains the authority: it re-validates every change and its error message is
 * shown if a move is refused (e.g. someone else changed the order meanwhile).
 */
export const ORDER_STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];
export const PAYMENT_STATUSES = ['pending', 'paid', 'failed'];

export const ORDER_TRANSITIONS = {
  pending: ['processing', 'shipped', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: [],
  cancelled: [],
};

export const STATUS_LABELS = {
  pending: 'Pending',
  processing: 'Processing',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const STATUS_STYLES = {
  pending: 'bg-[#FFF4E5] text-[#B4641B]',
  processing: 'bg-[#EAF1FB] text-[#2C5C9A]',
  shipped: 'bg-[#EEF0FD] text-[#4B4BB0]',
  delivered: 'bg-[#E6F6EC] text-[#1E824C]',
  cancelled: 'bg-[#FCE8EE] text-[#C8234B]',
};

export const PAYMENT_LABELS = { pending: 'Unpaid', paid: 'Paid', failed: 'Failed' };
export const PAYMENT_STYLES = {
  pending: 'bg-[#F4F1EE] text-[#6C5B4B]',
  paid: 'bg-[#E6F6EC] text-[#1E824C]',
  failed: 'bg-[#FCE8EE] text-[#C8234B]',
};
export const METHOD_LABELS = { cod: 'Cash on delivery', razorpay: 'Razorpay', paid: 'Prepaid' };

/** Button wording for each target status on the order detail page. */
export const ACTION_LABELS = {
  processing: 'Mark as processing',
  shipped: 'Mark as shipped',
  delivered: 'Mark as delivered',
  cancelled: 'Cancel order',
};

const inr = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** ₹ amount with up to 2 decimals; "—" for missing values (0 is shown as ₹0). */
export function formatINR(value) {
  return typeof value === 'number' && Number.isFinite(value) ? inr.format(value) : '—';
}

/** Date/time in India Standard Time, the store timezone used by the API's date filters. */
export function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export const textOr = (value, fallback = '—') => (value === null || value === undefined || value === '' ? fallback : value);
