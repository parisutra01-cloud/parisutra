// Unit tests for the order-number format helpers (Milestone 5B). No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LEGACY_BASE, formatOrderNumber, parseOrderNumber } from '../../src/services/orderNumber.js';

test('UNIT-ON-01 format is unchanged: "AL" + sequence; first number ever is AL10001', () => {
  assert.equal(formatOrderNumber(LEGACY_BASE + 1), 'AL10001');
  assert.equal(formatOrderNumber(123456), 'AL123456');
});

test('UNIT-ON-02 parseOrderNumber reads standard numbers only', () => {
  assert.equal(parseOrderNumber('AL10001'), 10001);
  assert.equal(parseOrderNumber('AL0010001'), 10001, 'leading zeros parse to the same sequence');
  for (const bad of ['al10001', 'AL', 'AL-1', 'AL10001 ', 'T100000', 'AL1234567890123456', null, undefined, 10001, { $gt: '' }]) {
    assert.equal(parseOrderNumber(bad), null, String(bad));
  }
});

test('UNIT-ON-03 format and parse round-trip', () => {
  for (const n of [10001, 99999, 100000, 987654321]) assert.equal(parseOrderNumber(formatOrderNumber(n)), n);
});
