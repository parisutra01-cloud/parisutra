// Unit tests for order input validation (Milestone 5A). No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_CART_LINES, MAX_QUANTITY_PER_PRODUCT, ORDER_STATUSES, OrderInputError,
  parseCartItems, parseShippingAddress, parseStatusFilter, parseTrackingQuery, toTrackingView,
} from '../../src/utils/orderInput.js';

const A = '64b7f0c2a1b2c3d4e5f60718';
const B = '64b7f0c2a1b2c3d4e5f60719';
const rejects = (fn, pattern) => assert.throws(fn, (err) => err instanceof OrderInputError && err.status === 400 && (!pattern || pattern.test(err.message)));

test('UNIT-OI-01 valid cart lines pass through unchanged', () => {
  assert.deepEqual(parseCartItems([{ productId: A, quantity: 2 }, { productId: B, quantity: 1 }]), [
    { productId: A, quantity: 2 }, { productId: B, quantity: 1 },
  ]);
});

test('UNIT-OI-02 repeated products are merged (first-seen order, case-insensitive id)', () => {
  assert.deepEqual(parseCartItems([
    { productId: A, quantity: 2 }, { productId: B, quantity: 1 }, { productId: A.toUpperCase(), quantity: 3 },
  ]), [{ productId: A, quantity: 5 }, { productId: B, quantity: 1 }]);
});

test('UNIT-OI-03 invalid quantities are rejected, never coerced', () => {
  for (const quantity of [0, -1, 1.5, '2', 'abc', NaN, Infinity, null, undefined, true, [1], { $gt: 0 }, MAX_QUANTITY_PER_PRODUCT + 1]) {
    rejects(() => parseCartItems([{ productId: A, quantity }]), undefined);
  }
  assert.deepEqual(parseCartItems([{ productId: A, quantity: MAX_QUANTITY_PER_PRODUCT }]), [{ productId: A, quantity: MAX_QUANTITY_PER_PRODUCT }]);
});

test('UNIT-OI-04 merged quantity above the per-product limit is rejected', () => {
  rejects(() => parseCartItems([{ productId: A, quantity: MAX_QUANTITY_PER_PRODUCT }, { productId: A, quantity: 1 }]), /at most/i);
});

test('UNIT-OI-05 cart structure: non-array, empty, null/array lines, bad ids, operators, nested values', () => {
  rejects(() => parseCartItems(undefined), /list/);
  rejects(() => parseCartItems('abc'), /list/);
  rejects(() => parseCartItems({ 0: { productId: A, quantity: 1 } }), /list/);
  rejects(() => parseCartItems([]), /empty/);
  rejects(() => parseCartItems([null]), /object/);
  rejects(() => parseCartItems([[A, 1]]), /object/);
  rejects(() => parseCartItems(['x']), /object/);
  for (const productId of [undefined, 123, 'abc', `${A}0`, 'zzzzzzzzzzzzzzzzzzzzzzzz', { $ne: null }, [A]]) {
    rejects(() => parseCartItems([{ productId, quantity: 1 }]), undefined);
  }
  rejects(() => parseCartItems([{ productId: A, quantity: 1, extra: { $where: '1' } }]), /nested/);
});

test('UNIT-OI-06 variation lines are rejected explicitly; blank variation fields are ignored', () => {
  rejects(() => parseCartItems([{ productId: A, quantity: 1, variationId: B }]), /variations/);
  rejects(() => parseCartItems([{ productId: A, quantity: 1, variationLabel: 'Red' }]), /variations/);
  assert.equal(parseCartItems([{ productId: A, quantity: 1, variationId: null, variationLabel: '' }]).length, 1);
});

test('UNIT-OI-07 cart line limits', () => {
  const many = Array.from({ length: MAX_CART_LINES + 1 }, (_, i) => ({ productId: i.toString(16).padStart(24, '0'), quantity: 1 }));
  rejects(() => parseCartItems(many), /at most/);
  rejects(() => parseCartItems(Array.from({ length: 201 }, () => ({ productId: A, quantity: 1 }))), /at most/);
});

test('UNIT-OI-08 status filter: only known plain strings', () => {
  assert.equal(parseStatusFilter(undefined), null);
  assert.equal(parseStatusFilter(''), null);
  for (const s of ORDER_STATUSES) assert.equal(parseStatusFilter(s), s);
  for (const bad of ['PENDING', 'teleported', ['pending'], { $ne: 'cancelled' }, 'pending ']) {
    rejects(() => parseStatusFilter(bad), /Invalid status/);
  }
  assert.deepEqual(ORDER_STATUSES, ['pending', 'processing', 'shipped', 'delivered', 'cancelled']);
});

test('UNIT-OI-09 shipping address: plain object, string fields, line1 + pincode required', () => {
  assert.deepEqual(parseShippingAddress({ line1: ' 1 Road ', pincode: 400001, extra: 'x' }), { line1: '1 Road', pincode: '400001' });
  rejects(() => parseShippingAddress(null), /required/);
  rejects(() => parseShippingAddress('1 Road'), /required/);
  rejects(() => parseShippingAddress({ line1: 'x' }), /required/);
  rejects(() => parseShippingAddress({ line1: { $gt: '' }, pincode: '1' }), /text/);
  rejects(() => parseShippingAddress({ line1: 'x'.repeat(201), pincode: '1' }), /too long/);
});

test('UNIT-OI-10 tracking query is validated and normalised', () => {
  const f = parseTrackingQuery({ orderNumber: ' al10001 ', email: ' Someone@Example.COM ' });
  assert.equal(f.orderNumber, 'AL10001');
  assert.ok(f.customerEmail.test('someone@example.com') && f.customerEmail.test('SOMEONE@example.com'));
  assert.ok(!f.customerEmail.test('xsomeone@example.com'));
  rejects(() => parseTrackingQuery({}), /required/);
  rejects(() => parseTrackingQuery({ orderNumber: ['AL1'], email: 'a@b.co' }), /text/);
  rejects(() => parseTrackingQuery({ orderNumber: { $ne: 'x' }, email: { $ne: 'y' } }), /text/);
  rejects(() => parseTrackingQuery({ orderNumber: 'AL1', email: 'not-an-email' }), /email/);
  rejects(() => parseTrackingQuery({ orderNumber: 'AL1;drop', email: 'a@b.co' }), /order number/);
  // Regex metacharacters in the email are matched literally.
  assert.ok(!parseTrackingQuery({ orderNumber: 'AL1', email: 'a.*@b.co' }).customerEmail.test('abc@b.co'));
});

test('UNIT-OI-11 tracking view is an allowlist', () => {
  const view = toTrackingView({
    _id: 'x', orderNumber: 'AL1', status: 'shipped', createdAt: 1, updatedAt: 2, total: 10, user: 'u',
    customerEmail: 'e', customerPhone: 'p', customerName: 'n', shippingAddress: { line1: 'l' },
    razorpayOrderId: 'r', razorpayPaymentId: 'r2', paymentStatus: 'paid', paymentMethod: 'razorpay', notes: 'n',
    items: [{ product: 'pid', title: 'T', quantity: 2, unit: 'meter', image: '/i.jpg', price: 5 }],
  });
  assert.deepEqual(view, {
    orderNumber: 'AL1', status: 'shipped', createdAt: 1, updatedAt: 2, total: 10, itemCount: 1,
    items: [{ title: 'T', quantity: 2, unit: 'meter', image: '/i.jpg' }],
  });
});
