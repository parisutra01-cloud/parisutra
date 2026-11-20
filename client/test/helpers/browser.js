/**
 * Dependency-free headless Chrome driver over the Chrome DevTools Protocol (CDP), using Node's
 * built-in WebSocket (Node >= 22). Used for routing regression tests where a real browser is needed.
 *
 * Safety: every request whose host is not localhost/127.0.0.1 is failed by the browser before it is
 * sent (CDP Fetch interception), so tests cannot reach Google Fonts, Firebase, Cloudinary, Razorpay
 * or any other external service. Blocked URLs are recorded on page.blocked.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function findChrome() {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const probe = spawnSync('which', [name], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function launchBrowser() {
  const bin = findChrome();
  if (!bin) return null;
  if (typeof WebSocket === 'undefined') return null;
  const userDataDir = mkdtempSync(path.join(os.tmpdir(), 'parisutra-test-chrome-'));
  const proc = spawn(bin, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-features=Translate,OptimizationHints,MediaRouter,AutofillServerCommunication',
    '--metrics-recording-only',
    '--mute-audio',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: 'ignore' });
  const killNow = () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } };
  process.once('exit', killNow);

  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 20000;
  while (!existsSync(portFile) || readFileSync(portFile, 'utf8').split('\n').length < 2) {
    if (Date.now() > deadline) { killNow(); throw new Error('Chrome did not expose a DevTools port'); }
    await sleep(100);
  }
  const [port, wsPath] = readFileSync(portFile, 'utf8').trim().split('\n');
  const ws = new WebSocket(`ws://127.0.0.1:${port}${wsPath}`);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

  let nextId = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
      else resolve(msg.result);
    } else if (msg.method) {
      for (const l of listeners) l(msg);
    }
  };
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

  async function newPage() {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (method, params) => send(method, params, sessionId);
    const page = { exceptions: [], consoleErrors: [], blocked: [], holds: [], mocks: [], mocked: [] };

    listeners.add((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Fetch.requestPaused') {
        const { requestId, request } = msg.params;
        let host = '';
        try { host = new URL(request.url).host.replace(/:\d+$/, ''); } catch { /* data: etc. */ }
        // Mocked responses are produced inside the browser; the request is never sent anywhere.
        const mock = page.mocks.find((m) => m.method === request.method && m.pattern.test(request.url));
        if (mock) {
          page.mocked.push(`${request.method} ${request.url}`);
          const { status = 200, body = {} } = mock.handler(request);
          s('Fetch.fulfillRequest', {
            requestId,
            responseCode: status,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Access-Control-Allow-Origin', value: '*' },
            ],
            body: Buffer.from(JSON.stringify(body)).toString('base64'),
          }).catch(() => {});
          return;
        }
        if (!LOCAL_HOSTS.has(host)) {
          page.blocked.push(request.url);
          s('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
          return;
        }
        const hold = page.holds.find((h) => h.pattern.test(request.url));
        const go = () => s('Fetch.continueRequest', { requestId }).catch(() => {});
        if (hold) setTimeout(go, hold.ms); else go();
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        page.exceptions.push(d.exception?.description || d.text);
      } else if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
        page.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });

    await s('Page.enable');
    await s('Runtime.enable');
    await s('Fetch.enable', { patterns: [{ urlPattern: '*' }] });

    page.evaluate = async (expression) => {
      // userGesture: scripted clicks count as user activation, like real clicks. Without it Chrome's
      // history intervention may skip the resulting history entries on back/forward.
      const res = await s('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
      if (res.exceptionDetails) throw new Error(`evaluate failed: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`);
      return res.result.value;
    };
    page.waitFor = async (expression, { timeout = 10000, interval = 50 } = {}) => {
      const end = Date.now() + timeout;
      let last;
      while (Date.now() < end) {
        try { last = await page.evaluate(expression); if (last) return last; } catch { /* page navigating */ }
        await sleep(interval);
      }
      return last;
    };
    page.goto = async (url) => {
      await s('Page.navigate', { url });
      await page.waitFor("document.readyState === 'complete'", { timeout: 20000 });
    };
    page.reload = async () => {
      await s('Page.reload', { ignoreCache: false });
      await sleep(50);
      await page.waitFor("document.readyState === 'complete'", { timeout: 20000 });
    };
    /** Browser toolbar Back/Forward (steps through the tab's real navigation history). */
    const step = async (delta) => {
      const { currentIndex, entries } = await s('Page.getNavigationHistory');
      const target = entries[currentIndex + delta];
      if (!target) throw new Error(`no history entry at offset ${delta}`);
      await s('Page.navigateToHistoryEntry', { entryId: target.id });
      return target.url;
    };
    page.back = () => step(-1);
    page.forward = () => step(1);
    /** Raw CDP call on this page's session (e.g. Page.captureScreenshot when debugging a failure). */
    page.cdp = (method, params) => s(method, params);
    /** Answers matching requests locally with handler(request) → { status, body }. */
    page.mock = (method, pattern, handler) => { page.mocks.push({ method, pattern, handler }); };
    page.clearMocks = () => { page.mocks.length = 0; };
    /** Selects files on an <input type=file> exactly as a user would (fires input/change). */
    page.setFiles = async (selector, files) => {
      const { result } = await s('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(selector)})` });
      if (!result.objectId) throw new Error(`no element for ${selector}`);
      await s('DOM.setFileInputFiles', { files, objectId: result.objectId });
    };
    /** Delays matching local requests by `ms` (used to observe the auth-loading window). */
    page.hold = (pattern, ms) => { page.holds.push({ pattern, ms }); };
    page.clearHolds = () => { page.holds.length = 0; };
    page.resetLogs = () => { page.exceptions.length = 0; page.consoleErrors.length = 0; };
    page.close = () => send('Target.closeTarget', { targetId }).catch(() => {});
    return page;
  }

  async function close() {
    try { ws.close(); } catch { /* ignore */ }
    killNow();
    await sleep(200);
    rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
  }

  return { newPage, close };
}

/** Starts the Vite dev server for client/ on a given port, pointed at a test API. */
export async function startViteDevServer({ clientDir, port, apiBase }) {
  const viteBin = path.join(clientDir, '..', 'node_modules', 'vite', 'bin', 'vite.js');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'development',
    VITE_API_URL: apiBase,
    // Blank Firebase web config so the client never initialises Firebase during tests.
    VITE_FIREBASE_API_KEY: '',
    VITE_FIREBASE_AUTH_DOMAIN: '',
    VITE_FIREBASE_PROJECT_ID: '',
    VITE_FIREBASE_STORAGE_BUCKET: '',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '',
    VITE_FIREBASE_APP_ID: '',
  };
  const proc = spawn(process.execPath, [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    cwd: clientDir, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  process.once('exit', () => { try { proc.kill('SIGKILL'); } catch { /* gone */ } });
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 30000;
  for (;;) {
    try { const r = await fetch(`${origin}/`); if (r.ok) break; } catch { /* not up yet */ }
    if (Date.now() > deadline || proc.exitCode !== null) throw new Error(`Vite did not start:\n${log}`);
    await sleep(200);
  }
  return {
    origin,
    close: async () => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } await sleep(100); },
  };
}
