import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import AdminIcon from '../../components/admin/AdminIcons.jsx';
import { api } from '../../api/client.js';
import {
  ACTION_LABELS, METHOD_LABELS, ORDER_TRANSITIONS, PAYMENT_LABELS, PAYMENT_STYLES, STATUS_LABELS, STATUS_STYLES,
  formatDateTime, formatINR, textOr,
} from '../../utils/adminOrders.js';

/**
 * Admin order detail (Phase 5F), backed by GET /api/orders/:id. Status changes go through
 * PATCH /api/orders/:id/status; the server enforces the transition rules and performs cancellation
 * (including any stock restoration) in a transaction. Nothing here simulates success.
 */
const card = 'bg-white rounded-xl border border-[#F2E2E6] shadow-2xs p-4';
const h2 = 'text-[13px] font-bold text-[#B8294B] mb-3';

function Badge({ children, className, testId }) {
  return <span data-testid={testId} className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${className}`}>{children}</span>;
}

function Row({ label, children }) {
  return (
    <div className="flex justify-between gap-4 py-1.5 text-[12.5px]">
      <span className="text-[#4A6B8C]">{label}</span>
      <span className="text-right font-medium text-[#142C4C] break-words min-w-0">{children}</span>
    </div>
  );
}

function confirmText(order, to) {
  if (to !== 'cancelled') {
    return `Change order #${order.orderNumber || ''} from ${STATUS_LABELS[order.status]} to ${STATUS_LABELS[to]}? Orders cannot be moved back to an earlier status.`;
  }
  const lines = ['Cancelling is final: a cancelled order cannot be reopened.'];
  const r = order.stockReservation;
  if (r?.recorded && !r.restoredAt) {
    const units = (r.lines || []).reduce((s, l) => s + (l.quantity || 0), 0);
    lines.push(units ? `${units} reserved unit${units === 1 ? '' : 's'} will be returned to stock.` : 'No tracked stock was reserved for this order.');
  } else {
    lines.push('This order has no recorded stock reservation, so stock will NOT be changed automatically. Adjust inventory manually if needed.');
  }
  if (order.payment?.status === 'paid') {
    lines.push('This order is marked paid. Refunds are not handled here: process any refund in the payment provider.');
  }
  return lines.join(' ');
}

export default function AdminOrderDetailPage() {
  const { id } = useParams();
  const [order, setOrder] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | invalid | missing | error
  const [loadError, setLoadError] = useState('');
  const [pending, setPending] = useState(null); // target status awaiting confirmation
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState('');
  const [toast, setToast] = useState('');
  const toastTimer = useRef();
  const inFlight = useRef(false); // blocks a second submit before React re-renders

  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setState('loading');
    try {
      const d = await api(`/orders/${id}`);
      setOrder(d.order);
      setState('ready');
    } catch (err) {
      if (err.status === 400) setState('invalid');
      else if (err.status === 404) setState('missing');
      else { setLoadError(err.message || 'Could not load this order.'); setState('error'); }
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const showToast = (msg) => {
    clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(''), 4500);
  };

  const applyStatus = async () => {
    if (!pending || inFlight.current) return;
    inFlight.current = true;
    setSaving(true);
    setActionError('');
    try {
      const res = await api(`/orders/${order._id}/status`, { method: 'PATCH', body: JSON.stringify({ status: pending }) });
      let msg = res.changed ? `Order marked as ${STATUS_LABELS[pending].toLowerCase()}.` : `Order was already ${STATUS_LABELS[pending].toLowerCase()}.`;
      if (pending === 'cancelled' && res.changed) {
        msg += res.stockRestoration === 'restored' ? ' Reserved stock was returned.' : ' Stock was not changed (no recorded reservation).';
      }
      setPending(null);
      showToast(msg);
    } catch (err) {
      setActionError(err.message || 'The status could not be changed.');
    } finally {
      await load({ quiet: true }); // always show the server's current state
      inFlight.current = false;
      setSaving(false);
    }
  };

  if (state === 'loading') {
    return <div className="text-[13px] text-[#4A6B8C]" data-testid="order-loading">Loading order…</div>;
  }
  if (state !== 'ready') {
    const messages = {
      invalid: ['This order link is not valid.', 'The address does not contain a valid order id.'],
      missing: ['Order not found.', 'It may have been removed, or the link is wrong.'],
      error: ['Could not load this order.', loadError],
    };
    const [title, detail] = messages[state];
    return (
      <div className={`${card} max-w-lg`} data-testid={`order-${state}`}>
        <p className="text-[14px] font-bold text-[#B4233F]">{title}</p>
        <p className="mt-1 text-[12.5px] text-[#4A6B8C]">{detail}</p>
        <div className="mt-4 flex gap-2">
          {state === 'error' && <button type="button" onClick={() => load()} className="px-3 py-2 rounded-lg border border-[#E6D3D9] text-[12px] font-semibold cursor-pointer">Try again</button>}
          <Link to="/admin/orders" className="px-3 py-2 rounded-lg bg-[#B8294B] text-white text-[12px] font-semibold">Back to orders</Link>
        </div>
      </div>
    );
  }

  const nextStatuses = ORDER_TRANSITIONS[order.status] || [];
  const address = order.shippingAddress;
  const r = order.stockReservation;

  return (
    <div className="text-[#1E3A5F] space-y-4" data-testid="order-detail">
      {toast && (
        <div role="status" data-testid="toast" className="fixed bottom-5 right-5 z-50 max-w-sm rounded-xl bg-[#1E3A5F] px-4 py-2.5 text-xs font-semibold text-white shadow-lg">{toast}</div>
      )}

      <div className="flex items-center gap-1.5 text-[12px] text-[#4A6B8C]">
        <Link to="/admin/orders" className="hover:text-[#B8294B]">Orders</Link>
        <AdminIcon name="chevron-right" size={12} className="text-[#7A93AC]" />
        <span className="font-medium text-[#1E3A5F]">#{textOr(order.orderNumber)}</span>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[24px] font-bold text-[#B8294B] leading-tight" style={{ fontFamily: 'Georgia, serif' }} data-testid="order-title">
            Order #{textOr(order.orderNumber)}
          </h1>
          <p className="mt-1 text-[12.5px] text-[#4A6B8C]">Placed {formatDateTime(order.createdAt)} IST</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge testId="detail-status" className={STATUS_STYLES[order.status] || 'bg-neutral-100 text-neutral-600'}>{STATUS_LABELS[order.status] || textOr(order.status)}</Badge>
          <Badge testId="detail-payment" className={PAYMENT_STYLES[order.payment?.status] || 'bg-neutral-100 text-neutral-600'}>{PAYMENT_LABELS[order.payment?.status] || textOr(order.payment?.status)}</Badge>
        </div>
      </div>

      {/* Status actions: only moves the server allows from the current status. */}
      <div className={card}>
        <h2 className={h2}>Order status</h2>
        {nextStatuses.length ? (
          <div className="flex flex-wrap gap-2" data-testid="status-actions">
            {nextStatuses.map((to) => (
              <button
                key={to}
                type="button"
                disabled={saving}
                data-testid={`action-${to}`}
                onClick={() => { setActionError(''); setPending(to); }}
                className={`px-3.5 py-2 rounded-lg text-[12.5px] font-semibold cursor-pointer disabled:opacity-50 ${to === 'cancelled' ? 'border border-[#E5B8C5] text-[#B4233F] bg-white hover:bg-[#FDF2F4]' : 'bg-[#1E3A5F] text-white hover:bg-[#142C4C]'}`}
              >
                {ACTION_LABELS[to]}
              </button>
            ))}
          </div>
        ) : (
          <p className="text-[12.5px] text-[#4A6B8C]" data-testid="status-final">This order is {STATUS_LABELS[order.status]?.toLowerCase() || 'closed'}; its status can no longer change.</p>
        )}
        {actionError && <p role="alert" data-testid="action-error" className="mt-3 text-[12.5px] font-medium text-[#B4233F]">{actionError}</p>}
        <p className="mt-3 text-[11px] text-[#6C849D]">Refunds, payment capture and marking cash-on-delivery orders as paid are not available here.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <section className={`${card} lg:col-span-2 overflow-x-auto`}>
          <h2 className={h2}>Items</h2>
          <table className="w-full min-w-[480px] text-[12.5px]">
            <thead>
              <tr className="text-left text-[11.5px] text-[#4A6B8C] border-b border-[#F1E2E6]">
                <th className="py-2 pr-2">Product</th>
                <th className="py-2 px-2 text-right">Price</th>
                <th className="py-2 px-2 text-right">Qty</th>
                <th className="py-2 pl-2 text-right">Line total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F5EAEC]" data-testid="items">
              {order.items.map((item, i) => (
                <tr key={`${item.product}-${i}`} data-testid="item-row">
                  <td className="py-2 pr-2">
                    <div className="flex items-center gap-2.5">
                      {item.image ? <img src={item.image} alt="" className="w-10 h-10 rounded-lg object-cover border border-[#EAE0E2]" /> : <span className="w-10 h-10 rounded-lg bg-[#F7EEF1]" />}
                      <div>
                        <p className="font-semibold text-[#142C4C]">{textOr(item.title, 'Untitled item')}</p>
                        <p className="text-[11px] text-[#6C849D]">{item.unit ? `per ${item.unit}` : ''}{item.variationLabel ? ` · ${item.variationLabel}` : ''}</p>
                      </div>
                    </div>
                  </td>
                  <td className="py-2 px-2 text-right">{formatINR(item.price)}</td>
                  <td className="py-2 px-2 text-right">{textOr(item.quantity)}</td>
                  <td className="py-2 pl-2 text-right font-semibold">{formatINR(item.lineTotal)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-3 ml-auto max-w-xs">
            <Row label="Subtotal">{formatINR(order.subtotal)}</Row>
            <Row label="Shipping">{formatINR(order.shipping)}</Row>
            <Row label="Total"><span data-testid="detail-total" className="text-[14px] font-bold">{formatINR(order.total)}</span></Row>
          </div>
        </section>

        <div className="space-y-4">
          <section className={card} data-testid="customer">
            <h2 className={h2}>Customer</h2>
            <Row label="Name">{textOr(order.customerName ?? order.customer?.name)}</Row>
            <Row label="Email">{textOr(order.customerEmail ?? order.customer?.email)}</Row>
            <Row label="Phone">{textOr(order.customerPhone)}</Row>
            {!order.customer && <p className="mt-1 text-[11px] text-[#6C849D]">No linked customer account.</p>}
          </section>

          <section className={card} data-testid="shipping">
            <h2 className={h2}>Shipping address</h2>
            {address ? (
              <address className="not-italic text-[12.5px] leading-relaxed text-[#142C4C]">
                {[address.fullName, address.line1, address.line2, [address.city, address.state].filter(Boolean).join(', '), address.pincode].filter(Boolean).map((line) => <div key={line}>{line}</div>)}
                {address.phone && <div className="mt-1 text-[#4A6B8C]">Phone: {address.phone}</div>}
              </address>
            ) : <p className="text-[12.5px] text-[#4A6B8C]">No shipping address recorded.</p>}
          </section>

          <section className={card} data-testid="payment">
            <h2 className={h2}>Payment</h2>
            <Row label="Method">{METHOD_LABELS[order.payment?.method] || textOr(order.payment?.method)}</Row>
            <Row label="Status">{PAYMENT_LABELS[order.payment?.status] || textOr(order.payment?.status)}</Row>
            {order.payment?.razorpayOrderId && <Row label="Razorpay order">{order.payment.razorpayOrderId}</Row>}
            {order.payment?.razorpayPaymentId && <Row label="Razorpay payment">{order.payment.razorpayPaymentId}</Row>}
          </section>

          <section className={card} data-testid="stock">
            <h2 className={h2}>Stock</h2>
            {r?.recorded ? (
              <>
                <Row label="Reserved">{formatDateTime(r.reservedAt)}</Row>
                <Row label="Units">{(r.lines || []).reduce((s, l) => s + (l.quantity || 0), 0)}</Row>
                <Row label="Returned to stock">{r.restoredAt ? formatDateTime(r.restoredAt) : 'No'}</Row>
                {r.missingProducts?.length > 0 && <p className="mt-1 text-[11px] text-[#B4233F]">{r.missingProducts.length} product(s) no longer existed when stock was returned.</p>}
              </>
            ) : (
              <p className="text-[12.5px] text-[#4A6B8C]" data-testid="stock-not-recorded">No stock reservation was recorded for this order (older or online-payment order).</p>
            )}
          </section>

          {(order.status === 'cancelled' || order.cancelledAt) && (
            <section className={card} data-testid="cancellation">
              <h2 className={h2}>Cancellation</h2>
              <Row label="Cancelled">{formatDateTime(order.cancelledAt)}</Row>
              <Row label="By">{order.cancelledBy === 'customer' ? 'Customer' : order.cancelledBy === 'admin' ? 'Admin' : '—'}</Row>
            </section>
          )}

          {order.notes && (
            <section className={card}>
              <h2 className={h2}>Notes</h2>
              <p className="text-[12.5px] whitespace-pre-wrap">{order.notes}</p>
            </section>
          )}
        </div>
      </div>

      {pending && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => saving || setPending(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" data-testid="confirm-dialog" className="bg-white rounded-2xl max-w-md w-full p-6 border border-[#F2E2E6] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 id="confirm-title" className="text-[16px] font-bold text-[#B8294B]">{ACTION_LABELS[pending]}?</h3>
            <p className="mt-3 text-[12.5px] text-[#1E3A5F] leading-relaxed" data-testid="confirm-message">{confirmText(order, pending)}</p>
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" disabled={saving} onClick={() => setPending(null)} data-testid="confirm-cancel" className="px-4 py-2 rounded-lg border border-[#E6D3D9] text-[12.5px] font-semibold cursor-pointer">Keep as is</button>
              <button type="button" disabled={saving} onClick={applyStatus} data-testid="confirm-apply" className={`px-4 py-2 rounded-lg text-white text-[12.5px] font-semibold cursor-pointer disabled:opacity-60 ${pending === 'cancelled' ? 'bg-[#B4233F]' : 'bg-[#1E3A5F]'}`}>
                {saving ? 'Saving…' : ACTION_LABELS[pending]}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
