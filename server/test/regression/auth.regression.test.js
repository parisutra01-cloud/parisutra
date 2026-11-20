// REGRESSION — authentication / session defects (ADM-008 / SEC-B, ADM-009 / SEC-C).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Admin session revocation and login throttling', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => { fx = await ctx.seed(); });

  test('AUTH-13 (ADM-008) a demoted admin\'s existing token loses admin access immediately → 403', async () => {
    const extra = await ctx.createUser({ role: 'admin', email: 'demoted@parisutra.test' });
    expectStatus(assert, await ctx.request('GET', '/orders', { token: extra.token }), 200, 'precondition: works while admin');
    await ctx.models.User.updateOne({ _id: extra.user._id }, { role: 'customer' });
    expectStatus(assert, await ctx.request('GET', '/orders', { token: extra.token }), 403);
  });

  test('AUTH-14 (ADM-008) a deleted admin\'s token is rejected → 401/403', async () => {
    const extra = await ctx.createUser({ role: 'admin', email: 'deleted@parisutra.test' });
    await ctx.models.User.deleteOne({ _id: extra.user._id });
    expectStatus(assert, await ctx.request('GET', '/contact', { token: extra.token }), [401, 403]);
    expectStatus(assert, await ctx.request('POST', '/categories', { token: extra.token, body: { name: 'Ghost Admin Cat' } }), [401, 403]);
  });

  test('AUTH-15 (ADM-009) repeated failed logins are throttled (429 within 25 attempts)', async () => {
    const codes = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await ctx.request('POST', '/auth/login', { body: { email: fx.admin.email, password: `wrong-${i}` } });
      codes.push(res.status);
    }
    assert.ok(codes.includes(429), `expected a 429 after repeated failures; saw ${[...new Set(codes)].join(',')}`);
  });
});
