# Parisutra API tests

Integration tests for the Express API, created from the admin QA audit
(`PARISUTRA_ADMIN_QA_REPORT.md`). Test IDs (e.g. `PROD-06`, `ORD-11`) and issue IDs
(e.g. `ADM-005`, `SEC-D`) match the report.

Framework: Node's built-in test runner (`node:test` + `node:assert`). No extra dependencies.

## Layout

| Path | Purpose | Expected today |
|---|---|---|
| `server/src/utils/mediaOrganization.test.js` | Original unit tests (unchanged) | ✅ pass |
| `server/test/api/` | **Stable suite.** Behaviour verified correct during the audit. Must stay green. | ✅ pass |
| `server/test/regression/` | **Regression suite.** Asserts the *correct* behaviour for every confirmed bug. | ❌ fails until the matching bug is fixed |
| `server/test/helpers/harness.js` | Isolated MongoDB + API process, fixtures, safety guards | — |
| `server/test/helpers/server-entry.js` | Starts the real `server/src/app.js` for tests (no dotenv) | — |

Stable suite files: `auth`, `authorization`, `products`, `products-admin` (admin product API),
`product-images` (Cloudinary flow against a local mock), `categories`, `categories-admin` (category
management, slug history, guarded delete, product relationships, category images), `order-input`
(cart validation, duplicate-line merging, status filters, tracking privacy, account email), `order-numbers`
(atomic order-number counter: initialisation from history, concurrency, restarts), `stock-reservation`
(atomic COD stock reservation, release on failure, deterministic races via test-only hooks), `order-status`
(state machine, exactly-once stock restoration in transactions), `order-status-standalone` (503 without
transactions), `order-admin` (admin order list/search/pagination, order detail,
dashboard statistics), `stock-adjustment` (manual add/remove and compare-and-set stock
counts, races with checkout and cancellation, audit log lines), `orders`, `uploads` (Cloudinary),
`cms`, `dashboard`, `error-responses`, `test-safety`. Unit tests: `server/test/unit/` (including `order-input`, `order-number`, `order-status`, `order-list-query` and `stock-input`).

Browser (end-to-end) suites live in `client/test/` (`npm run test:e2e`): `admin-routing` (direct links,
refresh, auth redirects), `admin-products` (product list, create, edit, delete, uploads) and
`admin-categories` (category list, create/edit, deactivate/restore, delete, storefront visibility) and
`admin-orders` (dashboard statistics, order list/search/filters/pagination, order detail, status actions) and
`admin-responsive` (admin layout at 390/430/768/1024/1440px, mobile navigation drawer). They need a
local Chrome/Chromium (`CHROME_BIN` to override) and are skipped otherwise.

`server/test/helpers/cloudinaryMock.js` is a local stand-in for the Cloudinary REST API. The API under test is
pointed at it with `CLOUDINARY_URL=…?upload_prefix=http://127.0.0.1:<port>`, so upload verification and
deletion are exercised without network access. In the browser suites, the direct browser→Cloudinary upload
is answered inside Chrome (`page.mock`), so it is never sent.

Regression suite files: `error-handling` (the 9 crash scenarios + wrong status codes), `validation`, `auth`,
`catalog`, `orders`, `inventory`, `dashboard`, `customers`, `security`.

## Commands (from the repo root)

```bash
npm test                 # unit + stable API suite (CI gate; should be green)
npm run test:unit        # original mediaOrganization tests only
npm run test:api         # stable API suite only
npm run test:regression  # known-bug suite (expected to FAIL until fixes land)
npm run test:all         # everything; runs all three even if one fails

# One file, readable output
node --test --test-reporter=spec server/test/regression/inventory.regression.test.js
# One test by name
node --test --test-name-pattern="ORD-11" server/test/regression/orders.regression.test.js
```

`test:regression` is deliberately **not** part of `npm test`, so known bugs don't block CI. When you fix a
bug, its regression tests should turn green. Once a file is fully green, move its tests into
`server/test/api/` so they protect the fix permanently. Never weaken an assertion to make it pass.

## Isolation and safety

- **MongoDB:** each test file starts its own throwaway `mongod` on `127.0.0.1` with a random port and a
  temporary `--dbpath`, then deletes both afterwards. It runs as a **single-node replica set** (`--replSet rs0`, like Atlas) so
  multi-document transactions work; pass `createTestContext(url, { replicaSet: false })` for a standalone server. Requires `mongod` on `PATH` (or set `MONGOD_BIN`).
  If no `mongod` is found, the API suites are **skipped** (not failed) and print the reason.
- **Alternative:** set `MONGODB_TEST_URI` to an existing **local** test database (it must be a replica set
  for the order-cancellation tests), e.g.
  `mongodb://127.0.0.1:27017/parisutra_test`. `assertSafeTestMongoUri()` refuses `mongodb+srv://`,
  `*.mongodb.net`, non-local hosts and database names without `test`. For a CI service container, allow its
  hostname explicitly: `MONGODB_TEST_ALLOWED_HOSTS=mongo`.
- **No production credentials:** the API runs in a child process whose environment is built from scratch
  (`buildServerEnv`). `server/.env` is never loaded, and a test-only `JWT_SECRET` is used.
- **Cloudinary:** `uploads.test.js` uses fake credentials and only exercises code that runs before any network
  call. No request reaches Cloudinary.
- **Razorpay / Firebase:** never configured, so `/auth/google` returns 503 and payment routes are not exercised.
- **API output:** `ctx.apiStdout()` returns what the API process printed (e.g. `[stock-audit]` lines).
- **Restarts:** `ctx.restartApi()` stops the API process and starts a new one on the same database
  (used to test per-process start-up behaviour such as the order-number counter sync).
- **Crashes:** because the API is a separate process, a crash (ADM-001) is reported as
  `API PROCESS CRASHED (<reason>)` on that test, and the API is restarted for the next one.

## Not covered here (needs a UI test layer)

These audit findings live in React code and were verified in a browser. They need React Testing Library or
Playwright, which the project does not have yet:

- ADM-002: admin screens using mock data and showing fake success toasts
- ADM-003: blank page on refresh or deep link (`AdminLayout` hooks order)
- ADM-004 (client part): dashboard revenue includes cancelled/unpaid orders; Products card shows page length
- ADM-017, ADM-019, ADM-020: missing error states, dead nav items, no admin logout

Also not automated: Cloudinary upload/replace/delete against a real account (needs a dedicated test
account), Razorpay flows, and real Google sign-in.
