// Unit tests for admin order-list query parsing (Milestone 5E). No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderInputError, parseDateRange, parseOrderListQuery } from '../../src/utils/orderInput.js';

const rejects = (query) => assert.throws(() => parseOrderListQuery(query), OrderInputError, JSON.stringify(query));

test('UNIT-OL-01 defaults and a filter built only from fixed field names', () => {
  assert.deepEqual(parseOrderListQuery({}), { filter: {}, page: 1, limit: 20, range: { from: null, to: null, timezone: 'Asia/Kolkata' } });
  const { filter, page, limit } = parseOrderListQuery({ page: '3', limit: '100', status: 'shipped', paymentStatus: 'paid' });
  assert.deepEqual([page, limit], [3, 100]);
  assert.deepEqual(filter, { status: 'shipped', paymentStatus: 'paid' });
  // Unknown parameters are ignored, never turned into database fields.
  assert.deepEqual(parseOrderListQuery({ total: '5', $where: '1', user: 'x' }).filter, {});
});

test('UNIT-OL-02 invalid paging, statuses, operators and arrays are rejected', () => {
  for (const q of [{ limit: '101' }, { limit: '0' }, { page: '0' }, { page: '1.5' }, { limit: ['5'] }, { page: { $gt: '0' } },
    { status: 'x' }, { paymentStatus: 'refunded' }, { paymentStatus: ['paid'] }, { q: { $regex: '.*' } }, { q: 'x'.repeat(101) }]) {
    rejects(q);
  }
});

test('UNIT-OL-03 IST calendar-day boundaries', () => {
  const { createdAt } = parseDateRange({ from: '2026-03-10', to: '2026-03-10' });
  assert.equal(createdAt.$gte.toISOString(), '2026-03-09T18:30:00.000Z');
  assert.equal(createdAt.$lt.toISOString(), '2026-03-10T18:30:00.000Z');
  for (const bad of ['2026-02-29', '2026-04-31', '2026-00-10', '26-03-10', '2026-03-10T00:00']) {
    assert.throws(() => parseDateRange({ from: bad }), OrderInputError, bad);
  }
  assert.throws(() => parseDateRange({ from: '2026-03-11', to: '2026-03-10' }), /later than/);
});

test('UNIT-OL-04 search is literal and length-limited', () => {
  const { filter } = parseOrderListQuery({ q: 'a.*(b' });
  assert.equal(filter.$or.length, 4);
  const name = filter.$or.find((c) => c.customerName).customerName;
  assert.ok(name.test('xA.*(Bx'));
  assert.ok(!name.test('aXXb'));
  assert.equal(filter.$or[0].orderNumber.source, '^A\\.\\*\\(B');
});
