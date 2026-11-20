/**
 * Isolated integration-test harness for the Parisutra API.
 *
 * Safety guarantees (enforced in code, not just by convention):
 *  - MongoDB: either a throwaway `mongod` spawned on 127.0.0.1 with a temp dbpath, or
 *    MONGODB_TEST_URI, which must pass assertSafeTestMongoUri() (local host, non-SRV,
 *    database name containing "test"). Atlas / *.mongodb.net / mongodb+srv are refused.
 *  - The API runs as a child process whose environment is built from scratch. server/.env
 *    is never loaded, so no real JWT secret, Cloudinary, Razorpay or Firebase credentials
 *    are present. Cloudinary values are fake and only exercise pre-network code paths.
 *  - The API is a separate process so a crash (unhandled rejection) is observed and
 *    reported per request instead of killing the test runner; it is restarted automatically.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(HERE, 'server-entry.js');

export const TEST_JWT_SECRET = 'parisutra-test-only-jwt-secret';
export const FAKE_CLOUDINARY = {
  CLOUDINARY_CLOUD_NAME: 'parisutra-test-fake-cloud',
  CLOUDINARY_API_KEY: '000000000000000',
  CLOUDINARY_API_SECRET: 'parisutra-test-fake-cloudinary-secret',
  CLOUDINARY_FOLDER: 'parisutra-test',
};
export const PASSWORDS = { admin: 'AdminPass123', customer: 'CustPass123' };

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** Throws unless the URI is a local, non-SRV MongoDB whose database name contains "test". */
export function assertSafeTestMongoUri(uri) {
  const fail = (why) => {
    throw new Error(`Refusing to use MongoDB URI for tests (${why}). Tests only run against a local test database.`);
  };
  if (!uri || typeof uri !== 'string') fail('empty');
  if (uri.startsWith('mongodb+srv://')) fail('SRV/Atlas URIs are not allowed');
  if (!uri.startsWith('mongodb://')) fail('unsupported scheme');
  const afterScheme = uri.slice('mongodb://'.length);
  const authority = afterScheme.split('/')[0];
  const hostsPart = authority.includes('@') ? authority.split('@').pop() : authority;
  const allowedExtra = (process.env.MONGODB_TEST_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean);
  for (const hostPort of hostsPart.split(',')) {
    const host = hostPort.startsWith('[') ? hostPort.slice(0, hostPort.indexOf(']') + 1) : hostPort.split(':')[0];
    if (/mongodb\.net$/i.test(host)) fail('Atlas host');
    if (!LOCAL_HOSTS.has(host) && !allowedExtra.includes(host)) fail(`non-local host "${host}"`);
  }
  const dbName = (afterScheme.split('/')[1] || '').split('?')[0];
  if (!/test/i.test(dbName)) fail('database name must contain "test"');
  return uri;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForPort(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); resolve(true); });
      sock.once('error', () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`mongod did not start listening on ${port}`);
}

function mongodBinary() {
  const bin = process.env.MONGOD_BIN || 'mongod';
  const probe = spawnSync(bin, ['--version'], { encoding: 'utf8' });
  return probe.status === 0 ? bin : null;
}

/** Turns a freshly started `mongod --replSet rs0` into a writable single-node replica set. */
async function initiateReplicaSet(port, timeoutMs = 20000) {
  const conn = await mongoose.createConnection(`mongodb://127.0.0.1:${port}/admin?directConnection=true`, {
    serverSelectionTimeoutMS: 10000,
  }).asPromise();
  try {
    await conn.db.admin().command({ replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: `127.0.0.1:${port}` }] } });
    const deadline = Date.now() + timeoutMs;
    while (!(await conn.db.admin().command({ hello: 1 })).isWritablePrimary) {
      if (Date.now() > deadline) throw new Error('replica set did not elect a primary');
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await conn.close();
  }
}

async function startMongo(dbName, { replicaSet = true } = {}) {
  if (process.env.MONGODB_TEST_URI) {
    const base = process.env.MONGODB_TEST_URI;
    return { uri: assertSafeTestMongoUri(base), stop: async () => {} };
  }
  const bin = mongodBinary();
  if (!bin) return null;
  const dbpath = mkdtempSync(path.join(os.tmpdir(), 'parisutra-test-mongod-'));
  const port = await freePort();
  // Single-node replica set (like Atlas), so multi-document transactions are available in tests.
  const args = ['--dbpath', dbpath, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'];
  if (replicaSet) args.push('--replSet', 'rs0');
  const proc = spawn(bin, args, {
    stdio: 'ignore',
  });
  const killNow = () => { try { proc.kill('SIGKILL'); } catch { /* already gone */ } };
  process.once('exit', killNow);
  await waitForPort(port);
  if (replicaSet) await initiateReplicaSet(port);
  return {
    uri: assertSafeTestMongoUri(`mongodb://127.0.0.1:${port}/${dbName}${replicaSet ? '?directConnection=true' : ''}`),
    stop: async () => {
      await new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', resolve);
        proc.kill('SIGTERM');
        setTimeout(() => { killNow(); resolve(); }, 5000).unref();
      });
      rmSync(dbpath, { recursive: true, force: true });
    },
  };
}

function buildServerEnv({ port, mongoUri, extraEnv }) {
  // Deliberately NOT spreading process.env: nothing from the developer's shell or .env leaks in.
  return {
    PATH: process.env.PATH,
    NODE_ENV: 'test',
    PORT: String(port),
    MONGODB_URI: mongoUri,
    JWT_SECRET: TEST_JWT_SECRET,
    CLIENT_URL: 'http://localhost:5173',
    ...extraEnv,
  };
}

/**
 * Creates an isolated context for one test file.
 * Returns { skipReason } when no local mongod is available (the suite is then skipped, not failed).
 */
export async function createTestContext(fileUrl, { extraEnv = {}, replicaSet = true } = {}) {
  const fileTag = path.basename(fileURLToPath(fileUrl)).replace(/\W+/g, '_').slice(0, 40);
  const dbName = `parisutra_test_${fileTag}_${process.pid}`;
  const mongo = await startMongo(dbName, { replicaSet });
  if (!mongo) {
    return {
      skipReason: 'No local mongod found. Install MongoDB (mongod on PATH), set MONGOD_BIN, or set MONGODB_TEST_URI to a local test database.',
      close: async () => {},
    };
  }

  await mongoose.connect(mongo.uri, { serverSelectionTimeoutMS: 10000 });
  await mongoose.connection.db.dropDatabase();

  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const env = buildServerEnv({ port, mongoUri: mongo.uri, extraEnv });

  let child;
  let stderr = '';
  let apiOutput = ''; // API stdout across restarts (e.g. structured log lines checked by tests)
  let closed = false;
  const crashLog = [];

  function startApi() {
    if (closed) return Promise.reject(new Error('Test context already closed: register ctx.close() in a file-level after() hook'));
    return new Promise((resolve, reject) => {
      stderr = '';
      child = spawn(process.execPath, [SERVER_ENTRY], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => reject(new Error(`API did not start:\n${stderr}`)), 20000);
      child.stdout.on('data', (d) => {
        apiOutput += d;
        if (String(d).includes('PARISUTRA_TEST_API_READY')) { clearTimeout(timer); resolve(); }
      });
      child.stderr.on('data', (d) => { stderr += d; });
      child.once('exit', (code) => { clearTimeout(timer); if (code !== null && code !== 0) child.crashedWith = code; });
    });
  }

  async function waitForExit(proc, ms) {
    if (proc.exitCode !== null || proc.signalCode !== null) return true;
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), ms);
      proc.once('exit', () => { clearTimeout(t); resolve(true); });
    });
  }

  await startApi();

  /** Stops the API process and starts a fresh one (same database), like an application restart. */
  async function restartApi() {
    const old = child;
    try { old?.kill('SIGTERM'); } catch { /* ignore */ }
    if (old && !(await waitForExit(old, 5000))) { try { old.kill('SIGKILL'); } catch { /* ignore */ } await waitForExit(old, 2000); }
    await startApi();
  }

  /**
   * Performs an HTTP request. Result: { status, body, headers, crashed, crashReason }.
   * status is null when the server died before responding.
   */
  async function request(method, urlPath, { token, body, rawBody, headers = {} } = {}) {
    if (closed) throw new Error(`request ${method} ${urlPath} after test context was closed`);
    const h ={ 'Content-Type': 'application/json', ...headers };
    if (token) h.Authorization = `Bearer ${token}`;
    const proc = child;
    let res;
    try {
      res = await fetch(`${base}${urlPath}`, {
        method,
        headers: h,
        body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      const died = await waitForExit(proc, 3000);
      if (!died) throw err;
      const reason = (stderr.match(/(CastError|ValidatorError|ValidationError|MongoServerError|E11000)[^\n]*/) || [stderr.split('\n')[0]])[0];
      crashLog.push({ method, urlPath, reason });
      await startApi();
      return { status: null, body: null, headers: new Headers(), crashed: true, crashReason: reason };
    }
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: res.status, body: parsed, headers: res.headers, crashed: false };
  }

  const models = {
    User: (await import('../../src/models/User.js')).User,
    Category: (await import('../../src/models/Category.js')).Category,
    Product: (await import('../../src/models/Product.js')).Product,
    Order: (await import('../../src/models/Order.js')).Order,
    WholesaleEnquiry: (await import('../../src/models/WholesaleEnquiry.js')).WholesaleEnquiry,
    Banner: (await import('../../src/models/Banner.js')).Banner,
  };
  await Promise.all(Object.values(models).map((m) => m.syncIndexes()));

  async function login(email, password) {
    const res = await request('POST', '/auth/login', { body: { email, password } });
    if (res.status !== 200) throw new Error(`Login fixture failed for ${email}: ${res.status}`);
    return res.body.token;
  }

  /** Seeds a standard fixture set: 1 admin, 1 customer, 2 categories, 2 products. */
  async function seed() {
    const { User, Category, Product } = models;
    const admin = await User.create({ name: 'Test Admin', email: 'admin@parisutra.test', password: PASSWORDS.admin, role: 'admin' });
    const customer = await User.create({ name: 'Test Customer', email: 'customer@parisutra.test', password: PASSWORDS.customer });
    const laces = await Category.create({ name: 'Laces', slug: 'laces', sortOrder: 1 });
    const trims = await Category.create({ name: 'Trims', slug: 'trims', sortOrder: 2 });
    const lace = await Product.create({
      title: 'Test Gold Lace', slug: 'test-gold-lace', sku: 'SKU-1', category: laces._id,
      price: 500, costPrice: 120, stock: 10, images: [{ url: '/images/product-1.jpg', isMain: true }],
    });
    const trim = await Product.create({
      title: 'Test Silver Trim', slug: 'test-silver-trim', sku: 'SKU-2', category: trims._id,
      price: 1200, costPrice: 300, stock: 3,
    });
    const tokens = {
      admin: await login(admin.email, PASSWORDS.admin),
      customer: await login(customer.email, PASSWORDS.customer),
    };
    return { admin, customer, laces, trims, lace, trim, tokens };
  }

  /** Creates an extra user and returns { user, token }. */
  async function createUser({ role = 'customer', email }) {
    const user = await models.User.create({ name: `Extra ${role}`, email, password: PASSWORDS.admin, role });
    return { user, token: await login(email, PASSWORDS.admin) };
  }

  function signToken(payload, opts = {}, secret = TEST_JWT_SECRET) {
    return jwt.sign(payload, secret, opts);
  }

  const shippingAddress = { fullName: 'Test', phone: '9999999999', line1: 'Test line', city: 'Test', state: 'Test', pincode: '400001' };
  function placeOrder(token, items) {
    return request('POST', '/orders', {
      token,
      body: { items, shippingAddress, customerName: 'Test Customer', customerEmail: 'customer@parisutra.test' },
    });
  }

  async function close() {
    if (closed) return;
    closed = true;
    try { child?.kill('SIGKILL'); } catch { /* ignore */ }
    try { await mongoose.connection.db?.dropDatabase(); } catch { /* ignore */ }
    await mongoose.disconnect().catch(() => {});
    await mongo.stop();
  }

  return {
    skipReason: false,
    base,
    request,
    seed,
    login,
    createUser,
    signToken,
    placeOrder,
    restartApi,
    /** Everything the API process printed to stdout so far. */
    apiStdout: () => apiOutput,
    models,
    mongoose,
    crashLog,
    close,
  };
}

/**
 * Asserts the API answered (did not crash) with one of the expected status codes.
 * Every failure message includes the actual status/body or the crash reason.
 */
export function expectStatus(assert, res, expected, note = '') {
  const list = Array.isArray(expected) ? expected : [expected];
  assert.equal(res.crashed, false, `${note} — expected HTTP ${list.join('/')}, but ${describeResult(res)}`);
  assert.ok(list.includes(res.status), `${note} — expected HTTP ${list.join('/')}, got ${describeResult(res)}`);
}

/** Human-readable summary of a request result, used in assertion messages. */
export function describeResult(res) {
  if (res.crashed) return `API PROCESS CRASHED (${res.crashReason})`;
  const body = typeof res.body === 'string' ? res.body.slice(0, 200) : JSON.stringify(res.body)?.slice(0, 200);
  return `status ${res.status}: ${body}`;
}
