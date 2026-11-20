// Error-response contract for behaviour introduced with the central error handler.
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('Error responses', { skip: ctx.skipReason }, () => {
  let fx;
  before(async () => { fx = await ctx.seed(); });

  test('ERR-02 unknown /api route returns a JSON 404 (not an HTML page)', async () => {
    const res = await ctx.request('GET', '/does-not-exist');
    expectStatus(assert, res, 404);
    assert.deepEqual(res.body, { message: 'Not found' });
  });

  test('ERR-03 malformed JSON returns a generic 400 message (no parser internals)', async () => {
    const res = await ctx.request('POST', '/products', { token: fx.tokens.admin, rawBody: '{"title":' });
    expectStatus(assert, res, 400);
    assert.deepEqual(res.body, { message: 'Malformed JSON body' });
  });

  test('ERR-01 client errors never expose Mongoose/MongoDB internals', async () => {
    const probes = [
      ['GET', '/products/abc'],
      ['PUT', '/products/abc', { price: 5 }],
      ['POST', '/products', { title: 'Bad Price', price: 'abc', category: String(fx.laces._id) }],
      ['POST', '/cms/banners', { subtitle: 'x' }],
    ];
    for (const [method, path, body] of probes) {
      const res = await ctx.request(method, path, { token: fx.tokens.admin, body });
      assert.equal(res.crashed, false, `${method} ${path} crashed`);
      assert.ok(res.status >= 400 && res.status < 500, `${method} ${path} → ${res.status}`);
      assert.doesNotMatch(JSON.stringify(res.body), /Cast to|ObjectId failed|E11000|ValidatorError|Path `|at .*\.js:\d+/, `${method} ${path} leaked internals`);
    }
  });
});
