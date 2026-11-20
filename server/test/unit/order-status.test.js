// Unit tests for the order state machine definition (Milestone 5D). No database needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ORDER_TRANSITIONS, canTransition, isTransactionUnsupported } from '../../src/services/orderStatus.js';
import { ORDER_STATUSES } from '../../src/utils/orderInput.js';

test('UNIT-OS-01 the transition map covers exactly the Order model statuses', () => {
  assert.deepEqual(Object.keys(ORDER_TRANSITIONS).sort(), [...ORDER_STATUSES].sort());
  for (const targets of Object.values(ORDER_TRANSITIONS)) {
    for (const t of targets) assert.ok(ORDER_STATUSES.includes(t), t);
  }
});

test('UNIT-OS-02 terminal states and forbidden moves', () => {
  for (const to of ORDER_STATUSES) {
    assert.equal(canTransition('delivered', to), false, `delivered → ${to}`);
    assert.equal(canTransition('cancelled', to), false, `cancelled → ${to}`);
  }
  assert.equal(canTransition('shipped', 'cancelled'), false);
  assert.equal(canTransition('shipped', 'processing'), false);
  assert.equal(canTransition('shipped', 'pending'), false);
  assert.equal(canTransition('processing', 'pending'), false);
  assert.equal(canTransition('pending', 'delivered'), false, 'cannot skip fulfilment');
  assert.equal(canTransition('pending', 'teleported'), false);
  assert.equal(canTransition('teleported', 'pending'), false);
});

test('UNIT-OS-03 permitted moves', () => {
  for (const [from, to] of [['pending', 'processing'], ['pending', 'shipped'], ['pending', 'cancelled'], ['processing', 'shipped'], ['processing', 'cancelled'], ['shipped', 'delivered']]) {
    assert.equal(canTransition(from, to), true, `${from} → ${to}`);
  }
});

test('UNIT-OS-04 transaction-unsupported errors are recognised', () => {
  assert.ok(isTransactionUnsupported({ code: 20, message: 'Transaction numbers are only allowed on a replica set member or mongos' }));
  assert.ok(isTransactionUnsupported(new Error('Transaction numbers are only allowed on a replica set member or mongos')));
  assert.ok(!isTransactionUnsupported(new Error('WriteConflict')));
  assert.ok(!isTransactionUnsupported(undefined));
});
