// Unit tests for the error-handling building blocks (no database or network needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { wrapAsync, asyncRouter } from '../../src/utils/asyncRouter.js';
import { toHttpError, isDatabaseError } from '../../src/middleware/errorHandler.js';
import { escapeRegex } from '../../src/utils/escapeRegex.js';

const callWrapped = (fn) => new Promise((resolve) => {
  wrapAsync(fn)({}, {}, (err) => resolve(err));
});

test('wrapAsync forwards async rejections to next(err)', async () => {
  const boom = new Error('async boom');
  assert.equal(await callWrapped(async () => { throw boom; }), boom);
});

test('wrapAsync forwards synchronous throws to next(err)', async () => {
  const boom = new Error('sync boom');
  assert.equal(await callWrapped(() => { throw boom; }), boom);
});

test('wrapAsync turns a reason-less rejection into an Error (never next(undefined))', async () => {
  // eslint-disable-next-line prefer-promise-reject-errors
  const err = await callWrapped(() => Promise.reject());
  assert.ok(err instanceof Error);
});

test('wrapAsync leaves error-handling middleware (4 args) and non-functions untouched', () => {
  const errMw = (err, req, res, next) => next(err);
  assert.equal(wrapAsync(errMw), errMw);
  assert.equal(wrapAsync('/path'), '/path');
});

test('wrapAsync does not call next when the handler resolves normally', async () => {
  let called = false;
  wrapAsync(async () => 'ok')({}, {}, () => { called = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(called, false);
});

test('asyncRouter wraps handlers registered with route methods', () => {
  const router = asyncRouter();
  const handler = async () => {};
  router.get('/x', handler);
  const layer = router.stack.find((l) => l.route?.path === '/x');
  assert.notEqual(layer.route.stack[0].handle, handler, 'handler should be wrapped');
});

test('toHttpError: CastError → 400 "Invalid id" without the cast details', () => {
  const err = new mongoose.Error.CastError('ObjectId', 'abc', '_id');
  const { status, body } = toHttpError(err);
  assert.equal(status, 400);
  assert.equal(body.message, 'Invalid id');
  assert.doesNotMatch(JSON.stringify(body), /Cast to|abc/);
});

test('toHttpError: ValidationError → 400 with per-field messages only', () => {
  const doc = new mongoose.Document({}, new mongoose.Schema({ title: { type: String, required: true } }));
  const err = doc.validateSync();
  const { status, body } = toHttpError(err);
  assert.equal(status, 400);
  assert.equal(body.message, 'Validation failed');
  assert.deepEqual(body.errors, { title: 'title is required' });
});

test('toHttpError: duplicate key (11000) → 409 naming the field, never the raw Mongo message', () => {
  const err = Object.assign(new Error('E11000 duplicate key error collection: db.blogposts index: slug_1 dup key: { slug: "x" }'), {
    name: 'MongoServerError', code: 11000, keyPattern: { slug: 1 }, keyValue: { slug: 'x' },
  });
  const { status, body } = toHttpError(err);
  assert.equal(status, 409);
  assert.equal(body.message, 'A record with this slug already exists');
  assert.doesNotMatch(JSON.stringify(body), /E11000|collection|index/);
});

test('toHttpError: malformed JSON → 400 generic message', () => {
  const err = Object.assign(new SyntaxError('Unexpected end of JSON input'), { type: 'entity.parse.failed', status: 400 });
  assert.deepEqual(toHttpError(err), { status: 400, body: { message: 'Malformed JSON body' } });
});

test('toHttpError: deliberate 4xx application errors keep their message', () => {
  const err = Object.assign(new Error('Select a valid category before uploading'), { status: 400 });
  assert.deepEqual(toHttpError(err), { status: 400, body: { message: 'Select a valid category before uploading' } });
});

test('toHttpError: unexpected errors → 500 "Server error" (message and stack never exposed)', () => {
  const err = new TypeError("Cannot read properties of undefined (reading 'secret')");
  const res = toHttpError(err);
  assert.deepEqual(res, { status: 500, body: { message: 'Server error' } });
  const err5 = Object.assign(new Error('Invalid Cloudinary folder configuration'), { status: 500 });
  assert.deepEqual(toHttpError(err5), { status: 500, body: { message: 'Server error' } });
});

test('toHttpError: other database errors → 503 generic', () => {
  const err = Object.assign(new Error('connection refused to cluster0.mongodb.net'), { name: 'MongoNetworkError' });
  assert.deepEqual(toHttpError(err), { status: 503, body: { message: 'Service temporarily unavailable' } });
});

test('isDatabaseError distinguishes Mongo/Mongoose errors from business errors', () => {
  assert.equal(isDatabaseError(Object.assign(new Error('dup'), { code: 11000 })), true);
  assert.equal(isDatabaseError(new mongoose.Error.CastError('ObjectId', 'x', '_id')), true);
  assert.equal(isDatabaseError(new Error('Insufficient stock for Gold Lace')), false);
});

test('escapeRegex makes metacharacters literal', () => {
  const input = 'a.b*(c)[d]+?^$|{e}\\';
  assert.ok(new RegExp(escapeRegex(input)).test(input));
  assert.equal(new RegExp(escapeRegex('(')).test('('), true);
  assert.equal(new RegExp(escapeRegex('a.c')).test('abc'), false);
});
