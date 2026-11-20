// Authentication — behaviour verified as CORRECT during the audit (report §3, AUTH-01…12).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus, PASSWORDS, TEST_JWT_SECRET } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Authentication', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => { fx = await ctx.seed(); });

  test('AUTH-01 admin login with valid credentials returns a token and role=admin', async () => {
    const res = await ctx.request('POST', '/auth/login', { body: { email: fx.admin.email, password: PASSWORDS.admin } });
    expectStatus(assert, res, 200);
    assert.equal(res.body.user.role, 'admin');
    assert.equal(typeof res.body.token, 'string');
    assert.equal(res.body.user.password, undefined, 'password hash must never be returned');
  });

  test('AUTH-01b login is case-insensitive on email', async () => {
    const res = await ctx.request('POST', '/auth/login', { body: { email: fx.admin.email.toUpperCase(), password: PASSWORDS.admin } });
    expectStatus(assert, res, 200);
  });

  test('AUTH-02 wrong password returns 401 with a generic message', async () => {
    const res = await ctx.request('POST', '/auth/login', { body: { email: fx.admin.email, password: 'wrong-password' } });
    expectStatus(assert, res, 401);
    assert.equal(res.body.message, 'Invalid email or password');
  });

  test('AUTH-02b unknown email returns the same generic 401 (no user enumeration)', async () => {
    const res = await ctx.request('POST', '/auth/login', { body: { email: 'nobody@parisutra.test', password: 'whatever1' } });
    expectStatus(assert, res, 401);
    assert.equal(res.body.message, 'Invalid email or password');
  });

  test('AUTH-03 empty credentials return 400', async () => {
    expectStatus(assert, await ctx.request('POST', '/auth/login', { body: {} }), 400);
    expectStatus(assert, await ctx.request('POST', '/auth/login', { body: { email: fx.admin.email } }), 400);
  });

  test('AUTH-04 malformed email is rejected (400 or generic 401)', async () => {
    const res = await ctx.request('POST', '/auth/login', { body: { email: 'not-an-email', password: 'x' } });
    expectStatus(assert, res, [400, 401]);
  });

  test('AUTH-07 /auth/me returns the profile for a valid token', async () => {
    const res = await ctx.request('GET', '/auth/me', { token: fx.tokens.admin });
    expectStatus(assert, res, 200);
    assert.equal(res.body.user.email, fx.admin.email);
    assert.equal(res.body.user.role, 'admin');
  });

  test('AUTH-07b /auth/me without a token returns 401', async () => {
    expectStatus(assert, await ctx.request('GET', '/auth/me'), 401);
  });

  test('AUTH-08 expired JWT is rejected', async () => {
    const token = ctx.signToken({ sub: String(fx.admin._id), role: 'admin', exp: Math.floor(Date.now() / 1000) - 60 });
    expectStatus(assert, await ctx.request('GET', '/orders', { token }), 401);
  });

  test('AUTH-09 JWT signed with a different secret is rejected', async () => {
    const token = ctx.signToken({ sub: String(fx.admin._id), role: 'admin' }, {}, `${TEST_JWT_SECRET}-attacker`);
    expectStatus(assert, await ctx.request('GET', '/orders', { token }), 401);
  });

  test('AUTH-10 unsigned alg:none JWT is rejected', async () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const token = `${enc({ alg: 'none', typ: 'JWT' })}.${enc({ sub: String(fx.admin._id), role: 'admin' })}.`;
    expectStatus(assert, await ctx.request('GET', '/orders', { token }), 401);
  });

  test('AUTH-11 malformed bearer token is rejected', async () => {
    expectStatus(assert, await ctx.request('GET', '/orders', { token: 'garbage' }), 401);
    expectStatus(assert, await ctx.request('GET', '/orders', { headers: { Authorization: 'Basic abc' } }), 401);
  });

  test('AUTH-11b customer cannot escalate by forging role=admin without the secret', async () => {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const [h, , s] = fx.tokens.customer.split('.');
    const tampered = `${h}.${enc({ sub: String(fx.customer._id), role: 'admin' })}.${s}`;
    expectStatus(assert, await ctx.request('GET', '/orders', { token: tampered }), 401);
  });

  test('AUTH-12 Google sign-in without Firebase Admin config returns 503 (no external call)', async () => {
    expectStatus(assert, await ctx.request('POST', '/auth/google', { body: { idToken: 'x' } }), 503);
  });

  test('AUTH-16 registration creates a customer (never an admin) even if role is supplied', async () => {
    const res = await ctx.request('POST', '/auth/register', {
      body: { name: 'New User', email: 'new-user@parisutra.test', password: 'Password123', role: 'admin' },
    });
    expectStatus(assert, res, 201);
    assert.equal(res.body.user.role, 'customer');
  });
});
