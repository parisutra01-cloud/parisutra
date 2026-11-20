// Unit tests for manual stock operation validation (Phase 5G.2). No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_STOCK, StockInputError, parseStockAdjustment, parseStockSet } from '../../src/utils/stockInput.js';

const rejects = (fn, input) => assert.throws(() => fn(input), StockInputError, JSON.stringify(input));

test('UNIT-SI-01 valid adjustment; reason trimmed and whitespace collapsed', () => {
  assert.deepEqual(parseStockAdjustment({ operation: 'remove', quantity: 3, reason: '  Damaged   in  transit ' }), { operation: 'remove', quantity: 3, reason: 'Damaged in transit' });
  assert.equal(parseStockAdjustment({ operation: 'add', quantity: MAX_STOCK, reason: 'x' }).quantity, MAX_STOCK);
});

test('UNIT-SI-02 invalid adjustments', () => {
  for (const input of [null, [], 'add', {}, { operation: 'add', quantity: 1 }, { operation: 'ADD', quantity: 1, reason: 'x' },
    { operation: 'add', quantity: 0, reason: 'x' }, { operation: 'add', quantity: 1.5, reason: 'x' }, { operation: 'add', quantity: NaN, reason: 'x' },
    { operation: 'add', quantity: Infinity, reason: 'x' }, { operation: 'add', quantity: '1', reason: 'x' }, { operation: 'add', quantity: MAX_STOCK + 1, reason: 'x' },
    { operation: 'add', quantity: 1, reason: '' }, { operation: 'add', quantity: 1, reason: 'x'.repeat(201) }, { operation: 'add', quantity: 1, reason: ['x'] },
    { operation: 'add', quantity: 1, reason: 'x', $inc: { stock: 1 } }, { operation: 'add', quantity: 1, reason: 'x', actorId: 'u1' }]) {
    rejects(parseStockAdjustment, input);
  }
});

test('UNIT-SI-03 exact count: quantity whole ≥ 0, expectedStock any finite number', () => {
  assert.deepEqual(parseStockSet({ quantity: 0, expectedStock: -2, reason: 'fix' }), { quantity: 0, expectedStock: -2, reason: 'fix' });
  assert.equal(parseStockSet({ quantity: 4, expectedStock: 2.5, reason: 'fix' }).expectedStock, 2.5);
  for (const input of [{ quantity: 1, reason: 'x' }, { quantity: -1, expectedStock: 0, reason: 'x' }, { quantity: 1.5, expectedStock: 0, reason: 'x' },
    { quantity: 1, expectedStock: '0', reason: 'x' }, { quantity: 1, expectedStock: Infinity, reason: 'x' }, { quantity: 1, expectedStock: null, reason: 'x' },
    { quantity: 1, expectedStock: 0 }, { quantity: 1, expectedStock: 0, reason: 'x', stock: 5 }]) {
    rejects(parseStockSet, input);
  }
});
