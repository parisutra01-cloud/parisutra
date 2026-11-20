# Parisutra — Inventory Audit (Phase 5G.1, read-only)

Date: 20 Nov 2026 · Scope: admin inventory management · Mode: read-only (no source, test or config changes)

Evidence sources: code inspection, plus an isolated probe script run against a throwaway local MongoDB
(single-node replica set) via the existing test harness. The probe lived in the session scratchpad, not
in the repository. No production service was contacted.

Classification used for every finding: **Confirmed** (code + reproduced), **Suspected**, **Not implemented**,
**Already handled**.

---

## 1. Existing inventory architecture

```
Admin product form ──PUT /api/products/:id {…, stock: N}──► products.js PUT ──► $set: { stock: N }   (absolute)
Admin product list ──GET /api/products/manage?stock=low|out─► aggregate stats (lowStock, outOfStock)

COD checkout  ──POST /api/orders──► orderService.createCodOrder
                                     ├─ buildOrderFromItems (read, early friendly check)
                                     ├─ reserveLine: updateOne({stock ≥ q, active, tracked}, {$inc: -q})   (atomic)
                                     └─ on failure: releaseReservations ($inc +q, once each)
Razorpay verify ──orderService.createOrder──► buildOrderFromItems → Order.create → deductStock
                                                                       (findById → stock -= q → save() = $set stock)
Cancellation ──orderStatus.cancelOrder──► transaction: status → cancelled, $inc +q per recorded line,
                                          stockReservation.restoredAt

Admin "Inventory / Stock" page ──► hard-coded sample data, local state only (no API)
Admin "Inventory Reports" page ──► hard-coded sample data (no API)
```

There is **no inventory-specific API**. All stock writes from the admin go through the general product
update endpoint as an absolute value.

## 2. Relevant backend files

| File | Responsibility (inventory-related) |
|---|---|
| `server/src/models/Product.js` | `stock` (Number, default 0), `lowStockAlert` (default 10), `trackStock` (default true), `isActive`; `variations[].stock` (unused). Indexes: `slug` unique, text(title, shortDescription), `{category, isActive}` |
| `server/src/utils/productInput.js` | `parseProductInput`: `stock`/`lowStockAlert` whole numbers 0–10,000,000; `trackStock` boolean. Whitelisted fields only |
| `server/src/routes/products.js` | `POST /` create; `PUT /:id` partial update via `toUpdate()` → `$set` (absolute stock); `GET /manage` (filters `stock=in|low|out`, stats `lowStock`, `outOfStock`); public `GET /?inStock=true` (`stock > 0`) |
| `server/src/services/orderService.js` | `reserveLine` / `releaseReservations` / `createCodOrder` (atomic COD, 5C); `createOrder` + `deductStock` (Razorpay path, non-atomic, unchanged) |
| `server/src/services/orderStatus.js` | `cancelOrder`: transactional exactly-once restoration of recorded reservations (5D) |
| `server/src/services/orderStats.js` | Dashboard stats: product/category counts only, no stock metrics |
| `server/src/middleware/auth.js` | `authRequired`, `adminRequired` (JWT role) — all admin product routes use both |
| `server/src/middleware/errorHandler.js` | Central mapping (CastError/ValidationError → 400, DB → 503, else 500) |

## 3. Relevant frontend files

| File | Current state |
|---|---|
| `client/src/pages/admin/products/AdminInventoryPage.jsx` | **Sample data** (`INITIAL_INVENTORY`, `LOW_STOCK_PRODUCTS`, `STOCK_MOVEMENTS`). "Update stock" only changes local state and shows a success toast; threshold, bulk-update and Excel buttons only show toasts. Verified: no `api()` call in the file |
| `client/src/pages/admin/reports/AdminInventoryReportsPage.jsx` | **Sample data**, no API (reports; out of 5G scope) |
| `client/src/pages/admin/AdminProductFormPage.jsx` | Real. Stock, low-stock alert and track-stock fields. **On every save it sends the whole form, including the `stock` value loaded when the form opened** (`toPayload`, line 87) |
| `client/src/pages/admin/AdminProductsPage.jsx` | Real. Stock column with Low/Out badges, stock filter (`in/low/out`), stock sort, KPI "Low / Out of Stock" from `/products/manage` stats |
| `client/src/pages/admin/AdminDashboard.jsx` | Real (5F). Active products/categories; no stock metrics |
| `client/src/components/admin/AdminLayout.jsx` | Nav: "Inventory / Stock" → `/admin/products/inventory`, "Inventory Reports" |
| `client/src/api/client.js` | `api()` with `err.status` / `err.errors` (reusable) |

Observed but out of scope: `client/src/pages/ProductDetailPage.jsx` (storefront) contains hard-coded
sample product objects with `stock` values; not investigated further.

## 4. Product stock fields

| Field | Meaning today | Notes |
|---|---|---|
| `stock` | Units available to sell (integer) | Default 0. Missing in legacy docs → read as 0 by Mongoose and by `$ifNull` in admin queries; conditional reservation (`stock ≥ q`) fails for missing → treated as 0 (consistent) |
| `trackStock` | `false` = unlimited (stock ignored at checkout) | Missing → `true` (default). Untracked products are never reserved or restored |
| `lowStockAlert` | Per-product low-stock threshold | Missing → 10. Low = tracked, `0 < stock ≤ lowStockAlert` |
| `isActive` | Sellable/visible | Reservation requires `isActive ≠ false` |
| `variations[].stock` | Unused | Variations cannot be ordered (5A); no inventory meaning |

## 5. Existing inventory API endpoints

| Endpoint | Inventory capability | Status |
|---|---|---|
| `GET /api/products/manage` | List with `stock=in|low|out`, `sort=stock-asc|desc`, `q` (title/SKU/slug), pagination, stats `lowStock`, `outOfStock` | **Already handled** (Milestone 3) — usable as the inventory list |
| `GET /api/products/manage/:id` | One product incl. stock fields | Already handled |
| `PUT /api/products/:id` | Sets `stock`, `lowStockAlert`, `trackStock` as **absolute values** | Exists; unsafe for stock (see §7, §8) |
| Stock adjustment (±N) | — | **Not implemented** |
| Compare-and-set stock (set N if still M) | — | **Not implemented** |
| Dashboard stock metrics | — | **Not implemented** (`/orders/stats` has none; `/products/manage` stats has counts) |

## 6. Existing tests and coverage

| Area | Tests | Covers |
|---|---|---|
| COD reservation (5C) | `server/test/api/stock-reservation.test.js` SR-01…14 | Atomic reserve, races (deterministic hooks), compensation, `$inc` release, untracked, deactivation mid-checkout |
| Cancellation (5D) | `order-status.test.js` OS-03…13, `order-status-standalone.test.js` | Exactly-once restore, concurrency, rollback, legacy/no-record orders |
| Inventory regressions | `regression/inventory.regression.test.js` ORD-10, INV-01…04 | Restore on cancel, no double restore, no oversell under concurrency, failed order leaves stock |
| Product stock validation | `products-admin.test.js` PM-*, `regression/validation` PROD-09/09b | Integer, non-negative, create/update |
| Product UI | `client/test/admin-products.e2e.test.js` PE-04 | Edit form saves stock = 7 (stock set via `PUT` must keep working) |
| Admin product stats | `products-admin.test.js` | `stock=low|out` filters and counts |
| **Gaps** | — | Admin stock edits vs concurrent checkout/cancellation; concurrent admin edits; adjustment endpoint; inventory UI; Razorpay-path deduction concurrency |

### Current baseline (run during this audit, unchanged code)

| Suite | Result |
|---|---|
| Unit | 41/41 |
| Stable API | 196/196 |
| Browser | 56/56 |
| Regression | 59/72 |

The 13 failing regression tests are the same as previously reported, all unrelated to inventory:
AUTH-13, AUTH-14, AUTH-15, CUST-01, CUST-02, CUST-03, WHS-01, WHS-02, SEC-I, SEC-J, SEC-M, CMS-03, CMS-07.
Passing inventory/order regressions (must stay green): ORD-10, INV-01, INV-02, INV-03, INV-04, ORD-11,
ORD-12, ORD-12b, ORD-12c, ORD-16, ORD-16b, ORD-18. No new failures discovered.

## 7. Inventory findings

| ID | Classification | Finding | Evidence |
|---|---|---|---|
| INV-A1 | **Confirmed (High)** | **Any product edit silently reverts stock to the value shown when the form was opened.** The form always sends `stock`; the server `$set`s it. Sales (and restored cancellations) made while the form was open are erased, which can cause overselling | Probe R1: stock 10 → form opened → customer buys 2 (stock 8) → admin edits only the description → **stock 10** |
| INV-A2 | **Confirmed (High)** | Stock restored by a cancellation is erased by a stale admin save | Probe R3: form loaded at 8 → cancellation restores to 10 → admin saves → **8** |
| INV-A3 | **Confirmed (Medium)** | Two admins editing stock: last write wins, the other change is lost | Probe R4: both load 10; A sets 15 (+5 received), B sets 7 (−3 damaged) → **7** (intended 12) |
| INV-A4 | **Confirmed (High, payment path)** | Razorpay-path `deductStock` is read-modify-write (`save()` issues `$set: { stock: <computed> }`): concurrent Razorpay orders oversell and stock goes negative; it can also overwrite concurrent COD reservations or admin changes | Probe R5 shows the `$set` command; R6: 6 concurrent `createOrder` for 1 unit → 6 orders, stock **−1**; R7: COD reservation + `deductStock` lost an update in 5 of 20 rounds. *Fix belongs to 5H (payment path, not approved)* |
| INV-A5 | **Confirmed (Medium)** | Admin "Inventory / Stock" page is entirely sample data; "Update stock" fakes success | Code inspection (no API calls; local `setItems` + toast) |
| INV-A6 | **Confirmed (Low, storefront)** | `GET /products?inStock=true` uses `stock > 0`, excluding untracked products (unlimited) whose stock is 0, although they can be ordered | Probe R9: untracked product with stock 0 not listed, order → 201 |
| INV-A7 | Already handled | Admin absolute set **between** a checkout's read and its reservation: the conditional reservation applies to the new value | Probe R2a: read 10 → admin sets 15 → reserve 2 → **13** (correct) |
| INV-A8 | Already handled | Admin lowers stock below the requested quantity mid-checkout: reservation fails cleanly, no negative stock | Probe R2c: admin sets 1 → reserve 2 → "Insufficient stock", final 1 |
| INV-A9 | Already handled | Negative stock input rejected (create and update) | Probe R10: `PUT {stock: -1}` → 400; PROD-09/09b |
| INV-A10 | Already handled | Legacy products without stock fields: treated as stock 0, tracked, shown as out of stock, cannot be oversold | Probe R8 |
| INV-A11 | Already handled | Deactivation during checkout; untracked products; COD compensation; exactly-once cancellation restore | SR-08…12, OS-03…11 |
| INV-A12 | Suspected (Low) | Existing negative stock (possible via INV-A4 or old data) is counted as "out of stock" but displayed as a negative number; an absolute set is the only way to correct it | Probe R10 (−3 counted in `outOfStock`); display not checked in UI |
| INV-A13 | Not implemented | Dashboard has no inventory indicators (low/out counts exist only on the products page) | Probe R11 |
| INV-A14 | Not implemented | No audit trail of who changed stock and why | By design (movement log deferred) |

## 8. Concurrency analysis (the prompt's scenario and related cases)

Initial stock 10; a checkout for 2 units; an admin sets 15.

| Ordering | Final stock | Correct? |
|---|---|---|
| Checkout reads 10 → admin sets 15 → checkout reserves 2 (conditional `$inc`) | **13** | Yes (R2a) |
| Checkout reserves 2 (→ 8) → admin sets 15 | **15** | **No** if the admin's 15 was based on the old count of 10 (+5 delivery intended → 13). The sale is erased: 2 phantom units can be sold again (R1/R2b) |
| Admin sets 15 based on a physical recount *after* the sale | 15 | Yes — but the system cannot tell this from the row above |
| Final stock 8 | impossible | The admin write always lands; 8 would require losing the admin write, which a `$set` cannot do |

**Root cause:** an absolute `$set` cannot know whether it was computed from up-to-date data. Every other
writer (COD reservation, release, cancellation restore) uses atomic `$inc`, which is safe with respect to
each other but is overwritten by any later absolute set computed from a stale read.

Related cases:

| Case | Today | After the recommended design |
|---|---|---|
| Concurrent admin adjustments | Last write wins (R4) | Two `$inc` adjustments both apply (+5, −3 → 12) |
| Checkout vs restock | Restock via form can erase the sale (R1) | Restock = `$inc +N`: commutes with reservations |
| Checkout vs stock reduction | Reduction via form can erase or double-count | Reduction = conditional `$inc −N` (rejects going below 0) |
| Cancellation restore vs admin edit | Stale save erases the restore (R3) | `$inc` commutes; recount uses compare-and-set and fails on mismatch |
| Product deactivated during checkout | Handled (SR-12) | Unchanged |
| Untracked products | Handled (not reserved/restored) | Adjustments allowed; stock is informational while untracked |
| Missing/legacy stock fields | Handled as 0 | Adjustment treats missing as 0 (`$inc` creates the field) |
| Razorpay `deductStock` | Absolute write, oversell (R4–R7) | **Unchanged** — needs 5H approval |

## 9. Recommended stock-adjustment architecture

Evaluation:

| Approach | Fit |
|---|---|
| Atomic `$inc` adjustment (±N) | **Best for receipts, damage, returns**: commutes with every other writer; no stale-read problem. Decrease uses a filter `stock ≥ N` to forbid negative stock |
| Conditional set / compare-and-set (`set N` only if stock is still `M`) | **Best for physical recounts** ("there are exactly 37 on the shelf"): safe because it fails with 409 if anything changed since the admin looked |
| Version-based optimistic concurrency (`__v`) | **Poor fit**: checkout reservations and cancellation restores use `updateOne`/`$inc`, which do not bump `__v`, so a version check would not detect the sales it is meant to protect against. Would require touching 5C/5D code |
| Minimum-stock validation | Required inside both operations (never below 0) |
| Explicit "adjust" vs "set" distinction | **Yes** — two clearly different operations in the API and UI |

**Recommendation (fits the current architecture with minimal change):**

1. New admin endpoint **`PATCH /api/products/:id/stock`** with exactly one of:
   - `{ "adjust": <non-zero integer> }` → `updateOne({ _id, stock ≥ −adjust (for decreases) }, { $inc: { stock: adjust } })`; 409 "would go below 0" otherwise; returns the new stock.
   - `{ "set": <integer ≥ 0>, "expected": <integer> }` → `updateOne({ _id, stock: expected (missing counts as 0) }, { $set: { stock: set } })`; on mismatch 409 with the current stock so the UI can show it.
   - Optional `lowStockAlert` / `trackStock` changes stay on the existing `PUT` (no race-sensitive data).
2. **Fix INV-A1/A2 in the existing product form path without breaking it**: the edit form sends `stock`
   only when the admin actually changed it, together with `expectedStock` (the value loaded); `PUT`
   applies a stock change with the same compare-and-set when `expectedStock` is present (409 + current
   value on mismatch). `PUT` without `stock` never touches stock. Plain `PUT { stock }` without
   `expectedStock` keeps today's behaviour for compatibility (PE-04, PROD-09b) — see decision D1.
3. Validation: integers only, `|adjust| ≤ 10,000,000`, result `≤ 10,000,000`; product must exist (404),
   invalid id 400, non-admin 401/403; operator objects rejected (reuse `productInput` helpers).
4. No transaction needed: each operation is a single-document atomic update. No movement log needed for
   correctness (see §13).

## 10. Proposed admin inventory UI (replace the sample page, same visual style)

- Table from `GET /api/products/manage` (already supports `q`, `stock=in|low|out`, `status`, stock sort,
  pagination, stats): product, SKU, category, stock, low-stock threshold, tracked yes/no, status badge.
- KPI cards from existing stats: total, low stock, out of stock (click to filter); URL-synced filters
  (same pattern as products/orders pages).
- Row action **"Adjust stock"** dialog with two tabs:
  - *Add / remove* (± quantity, shows resulting stock, cannot go below 0);
  - *Set exact count* (recount; sends the value shown as `expected`; on 409 shows "Stock changed to X
    since you opened this — review and retry").
- Low-stock threshold and tracking toggle: link to the product edit form (no duplicate editor).
- Remove fake controls (bulk Excel, fake movements, fake threshold modal) or mark them unavailable.
- Dashboard: add "Low stock" and "Out of stock" counts (from existing `/products/manage` stats — no new
  backend needed) linking to the filtered inventory page.

## 11. Proposed API changes

| Change | Type |
|---|---|
| `PATCH /api/products/:id/stock` (`adjust` or `set`+`expected`) | New, admin only |
| `PUT /api/products/:id`: honour optional `expectedStock` for stock changes | Additive, backward compatible |
| Product form sends `stock` only when changed, with `expectedStock` | Frontend (product management) — minimal, needs approval (D1) |
| `GET /products?inStock=true` should include untracked products (INV-A6) | Optional, storefront — needs approval (D4) |

## 12. Required tests

- API: adjust +/−; decrease below 0 → 409 and unchanged; set with matching/mismatching `expected`;
  missing stock field treated as 0; validation (non-integer, 0 adjust, both/neither modes, operators,
  huge values); 400/404/401/403.
- Concurrency (deterministic, existing hook pattern): checkout reservation interleaved with adjust (both
  apply); recount after a sale with stale `expected` → 409; two concurrent adjusts both apply;
  cancellation restore vs adjust; 50 concurrent mixed adjusts = exact sum.
- Regression for INV-A1/A2: product edit without stock change never touches stock; stale stock edit → 409.
- Existing suites unchanged and green (SR-*, OS-*, INV-01…04, PE-04, PROD-09/09b).
- Browser: inventory list/filters/KPIs from real data; adjust dialog success and 409 handling; no fake
  controls; mobile width (layout from 5F.1).

## 13. Risks and migration considerations

- **No data migration** is needed: fields already exist; missing values keep their defaults.
- **Razorpay path (INV-A4)** remains able to oversell and overwrite stock until 5H. Converting
  `deductStock` to atomic `$inc` (or reusing `reserveLine`) is a small change but alters payment-path
  behaviour (a shortage after payment), so it is not part of 5G.
- **Compatibility:** keeping plain `PUT { stock }` (D1 option b) leaves an unsafe path for any other API
  client; the admin UI would no longer use it.
- **Movement log trade-off:** without it there is no record of who changed stock, when or why, and no
  reconciliation after a crash between reservation and order insert (5C crash window). Correctness of
  adjustments does **not** depend on it. Recommended: keep it deferred; optionally log adjustments to the
  server log (`[stock] admin <id> product <id> adjust −3`) as a stop-gap — requires approval (D3).
- Negative stock already present (from INV-A4) is corrected with "set exact count".

## 14. Explicitly deferred

- Stock movement log collection (approved deferral).
- Razorpay/payment-path stock behaviour (5H).
- Variation-level stock.
- Bulk/Excel stock import.
- Inventory reports page (`AdminInventoryReportsPage`).
- Storefront sample product data in `ProductDetailPage.jsx`.

## 15. Phased implementation plan for 5G

| Step | Content | Tests |
|---|---|---|
| 5G.2 | Backend: `PATCH /products/:id/stock` (adjust, set+expected), validation helper, admin auth | API + deterministic concurrency tests |
| 5G.3 | Backend: `PUT` honours `expectedStock`; frontend product form sends stock only when changed (+ `expectedStock`) and handles 409 | Regression for INV-A1/A2; PE-04 stays green |
| 5G.4 | Frontend: real inventory page (list, filters, KPIs, adjust dialog), fake controls removed | Browser tests incl. 409 path and mobile |
| 5G.5 | Dashboard low/out-of-stock indicators (existing stats endpoint) | Browser test |
| (opt.) | `inStock` filter includes untracked products (INV-A6) | API test |

## Decisions requiring approval

- **D1** Product edit form + `PUT`: (a) require `expectedStock` whenever `PUT` changes stock (safest; API
  clients sending bare `stock` get 409/400 — PE-04 still passes because the form will send it), or
  (b) honour `expectedStock` when present and keep bare `stock` working (fully backward compatible).
  Recommendation: **(b) now**, the admin UI always sends `expectedStock`.
- **D2** Whether stock adjustments should require a free-text reason (it could not be stored without the
  deferred movement log).
- **D3** Optional server-log line per adjustment as a stop-gap audit trail.
- **D4** Fix the storefront `inStock` filter for untracked products (INV-A6) in 5G or leave it.
- **D5** Whether the Razorpay `deductStock` race (INV-A4) should be scheduled under 5H.
