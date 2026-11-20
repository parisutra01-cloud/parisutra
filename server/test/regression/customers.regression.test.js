// REGRESSION — customer management APIs do not exist (ADM-011). Paths follow the audit's recommendation
// (GET /api/users, GET /api/users/:id); adjust if the implementation chooses different routes.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Admin customer management (ADM-011)', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => { fx = await ctx.seed(); });

  test('CUST-01 admin can list customers without sensitive fields', async () => {
    const res = await ctx.request('GET', '/users', { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    const list = res.body.users ?? res.body.customers;
    assert.ok(Array.isArray(list), 'expected an array of users');
    assert.ok(list.some((u) => u.email === fx.customer.email));
    for (const u of list) {
      assert.equal(u.password, undefined, 'password hash must never be returned');
      assert.equal(u.firebaseUid, undefined, 'firebaseUid should not be exposed');
    }
  });

  test('CUST-02 admin can view a single customer', async () => {
    const res = await ctx.request('GET', `/users/${fx.customer._id}`, { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    assert.equal((res.body.user ?? res.body.customer).email, fx.customer.email);
  });

  test('CUST-03 customer listing is admin-only', async () => {
    expectStatus(assert, await ctx.request('GET', '/users', { token: fx.tokens.customer }), 403);
    expectStatus(assert, await ctx.request('GET', '/users'), 401);
  });
});
