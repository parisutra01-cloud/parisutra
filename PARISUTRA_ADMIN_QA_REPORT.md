# PARISUTRA — Admin Panel QA & Functionality Audit

| | |
|---|---|
| **Audit date** | 2026-11-20 |
| **Mode** | Read-only. No application source, env, Firebase config, Cloudinary assets or Git state was modified. This report is the only file added to the repo. |
| **Commit audited** | `ff44bbe` + uncommitted working tree (63 modified files, as of audit start) |
| **Test environment** | Isolated, throwaway MongoDB (`127.0.0.1:27999/parisutra_qa`, data in a temp scratch directory) + the real `server/src/app.js` launched with a test-only env (`server/.env` was **not** loaded: no Atlas, no live Cloudinary/Razorpay/Firebase credentials). A separate Vite instance on `:5199` pointed at this API for UI checks. Your running dev servers (`:5050`, `:5173`) and the Atlas database were not touched. |
| **Automated checks run** | 156 black-box API checks (102 pass / 54 fail / **9 server crashes**) + 7 browser checks + existing `npm test` (4/4 pass) + production build |

---

## 1. Executive summary

**Final score: 32 / 100**

The admin panel looks complete: 45 routed screens and a polished sidebar. Behind them, though, **only 4 screens talk to the backend** (Dashboard, Banners, Top-banner announcements, Contact messages). The other 41 screens, including **Products, Add/Edit Product, Categories, Inventory, all Orders screens, Customers and the Media Library**, render hardcoded `INITIAL_*` arrays. Their buttons mutate React state only and show success toasts ("Product … saved and published successfully!") while **no network request is made**. I verified this in a browser.

The backend is small (≈2.6k LOC), and its **admin authorization is solid**: all 25 admin endpoints correctly returned 401 without a token and 403 for a customer token, and forged, expired and `alg:none` JWTs were rejected. However:

1. **Any anonymous visitor can crash the API process** with `GET /api/products/abc`. Express 4 does not catch async errors, and Node 22 exits on unhandled rejections. 9 routes reproduced this.
2. **Refreshing or deep-linking to any `/admin/*` URL renders a blank page.** `AdminLayout` calls hooks after an early `return` (a React Rules-of-Hooks violation).
3. **Inventory and order integrity is weak.** Cancelling never restores stock, any status transition is allowed (cancelled → delivered), negative prices and stock are accepted, and order numbers collide under concurrency or after a deletion.
4. **Dashboard figures are wrong.** Sales include cancelled and unpaid COD orders, and "Products" is capped at 6.

### Severity tally

| Critical | High | Medium | Low |
|---|---|---|---|
| 3 | 9 | 12 | 9 |

### Scorecard

| Area | Score | Rationale |
|---|---|---|
| Functionality (30) | **7** | Product / order / customer / category / media management are not wired to the API; only CMS banners/announcements, contact list and dashboard are live (dashboard is inaccurate). |
| Security (25) | **12** | Server-side RBAC correct on every admin route and secrets not exposed; but unauthenticated DoS, stale-role JWTs for 7 days, no login throttling, `costPrice` leaked publicly, mass assignment. |
| Data integrity (20) | **7** | No stock restoration, no transition rules, negative price/stock, orphan category refs, order-number collisions, non-atomic stock deduction. |
| UI/UX (15) | **4** | Visually complete, but fake success feedback everywhere, blank page on refresh, no admin logout, 1.96 MB single bundle. |
| Error handling (10) | **2** | 9 crash paths; validation errors returned as 500; frontend silently swallows most API errors. |

---

## 2. Admin functionality inventory

### 2.1 Architecture map

```
client (React 19 + Vite + React Router 7 + Tailwind)
  App.jsx → /admin/* (45 routes) wrapped by components/admin/AdminLayout.jsx
  api/client.js → fetch(API_BASE + path) with Bearer token from localStorage('arc_token')
  context/AuthContext.jsx → email/password login + Firebase Google popup → exchanges for app JWT
server (Express 4.22 + Mongoose 8.24) — deployed as one Vercel function (api/index.js)
  middleware/auth.js → authRequired (JWT verify) / adminRequired (role claim in JWT)
  routes: auth, categories, products, orders, users, contact, cms, payments, wholesale, uploads
  Firebase Admin: used ONLY to verify Google ID tokens in POST /api/auth/google
  Cloudinary: signed direct upload (browser → Cloudinary), then server re-validates & registers MediaAsset
  Razorpay: prepare/verify (customer checkout; not exercised in this audit)
MongoDB models: User, Product, Category, Order, PaymentIntent, MediaAsset, Banner, Announcement,
  Faq, BlogPost, HomepageSection, ContactMessage, WholesaleEnquiry
```

**Authentication model:** Firebase is *not* the session authority. The server issues its own HS256 JWT (`{sub, role}`, 7-day expiry) after a password login or after verifying a Firebase ID token. `adminRequired` trusts the `role` claim in the token without re-reading the DB.

### 2.2 Admin API endpoints (backend)

| Method & path | Auth | Purpose | Wired to an admin UI? |
|---|---|---|---|
| GET `/api/categories/manage` | admin | List all categories | ❌ none |
| POST `/api/categories` | admin | Create category | ❌ |
| PATCH `/api/categories/:id` | admin | Rename category | ❌ |
| DELETE `/api/categories/:id` | admin | Delete (blocked if products/media) | ❌ |
| POST `/api/products` | admin | Create product | ❌ |
| PUT `/api/products/:id` | admin | Update product | ❌ |
| DELETE `/api/products/:id` | admin | Soft delete (`isActive=false`) | ❌ |
| GET `/api/orders` | admin | List ≤200 orders, `?status=` | ✅ Dashboard only |
| PATCH `/api/orders/:id/status` | admin | Set order status | ❌ |
| GET `/api/contact` | admin | ≤100 contact messages | ✅ |
| GET `/api/wholesale/enquiries` | admin | ≤200 enquiries | ⚠️ only in `AdminWholesalePage.jsx`, which is **not routed** |
| PATCH `/api/wholesale/enquiries/:id/status` | admin | Set enquiry status | ⚠️ same (unreachable) |
| GET `/api/uploads/config` | admin | Cloudinary public config | ✅ (Banners) |
| POST `/api/uploads/sign` | admin | Sign an upload for a category folder | ✅ (Banners) |
| GET `/api/uploads/assets` | admin | List MediaAssets | ❌ (Media page is mock) |
| POST `/api/uploads/assets` | admin | Verify & register uploaded asset | ✅ (Banners) |
| DELETE `/api/uploads/assets/:id` | admin | Delete asset (Cloudinary + DB) | ❌ |
| GET/POST/PUT/DELETE `/api/cms/banners[/:id]` | admin | Banner CRUD | ✅ |
| GET/POST/PUT/DELETE `/api/cms/announcements[/:id]` | admin | Top bar CRUD | ✅ |
| GET/POST/PUT/DELETE `/api/cms/faqs[/:id]` | admin | FAQ CRUD | ❌ (FAQ page is mock) |
| GET/PUT `/api/cms/homepage-sections[/:key]` | admin | Homepage sections | ❌ (Homepage page is mock) |
| GET/POST/PUT/DELETE `/api/cms/blogs[/:id]` | admin | Blog CRUD | ❌ (Blog page is mock) |
| GET `/api/cms/stats` | admin | Content counts | ❌ |

**Do not exist:** admin customer list/detail, admin order detail, admin product listing including inactive products, product restore, order search/pagination, review management, coupons, returns, reports/analytics aggregation, exports, inventory movements, wholesale customers/quotes/price lists/credit.

### 2.3 Admin screens (frontend), classified

| Status | Screens |
|---|---|
| **Live (calls API)** | `/admin` Dashboard · `/admin/content/banners` · `/admin/content/announcements` · `/admin/content/messages` |
| **Mock (hardcoded `INITIAL_*` state, actions are local-only)** | `/admin/products`, `/admin/products/new`, `/admin/products/:id/edit`, `/admin/products/bulk-upload`, `/admin/products/categories`, `/admin/products/variations`, `/admin/products/inventory`, `/admin/products/reviews`, `/admin/orders` + `pending` / `processing` / `shipped` / `delivered` / `cancelled` / `returns`, `/admin/customers` + `groups` / `reviews` / `email-marketing` / `loyalty`, `/admin/content` (hub), `/admin/content/faqs`, `/admin/content/homepage`, `/admin/content/blogs`, `/admin/media` |
| **Static display only (hardcoded figures, no persistence)** | `/admin/reports` + `sales` / `products` / `customers` / `marketing` / `inventory` / `export`, all 10 `/admin/wholesale/*` screens |
| **Orphaned** | `pages/admin/AdminWholesalePage.jsx` is the only real wholesale-enquiry UI, but it is not referenced in `App.jsx` |
| **Non-functional nav item** | Sidebar "Coupons & Offers" is a `<div>` with no route |

21 pages initialise from `useState(INITIAL_…)`; the rest render constants directly.

---

## 3. Features successfully tested (PASS, with evidence)

| ID | Feature | Result |
|---|---|---|
| AUTH-01/02/03 | Admin login: valid → 200 + `role:admin`; wrong password → 401; empty → 400 | ✅ |
| AUTH-07 | `/auth/me` returns admin profile | ✅ |
| AUTH-08/09/10/11 | Expired JWT, wrong-signature JWT, `alg:none` JWT, garbage token → 401 | ✅ |
| AUTH-12 | Google sign-in without Firebase Admin config → clean 503 | ✅ |
| AUTHZ-NOAUTH-01…25 | All 25 admin endpoints → 401 without token | ✅ |
| AUTHZ-CUST-01…25 | All 25 admin endpoints → 403 with a customer token | ✅ |
| UI | Logged-out visit to `/admin` redirects to `/login` | ✅ |
| PROD-01/02/03/05/08 | Valid create 201; missing title/category 400; price 0 400; duplicate title 409 | ✅ |
| PROD-16/17/19 | Malformed JSON 400; update title/price/stock/category persists (re-read after write); unknown id 404 | ✅ |
| PROD-25/26/29 | Delete = soft delete; hidden from public list; repeat delete 200 | ✅ |
| PROD-30/33/34 | Text search; `limit` clamped to 48; `price-asc` sort correct | ✅ |
| CAT-01…09 | Create; case-insensitive duplicate 409; empty / `../x` names 400; rename; rename-to-existing 409; delete with products 409; delete empty 200; malformed id 404 | ✅ |
| ORD-01/02 | COD order (test DB): subtotal/shipping/total correct; stock decremented | ✅ |
| ORD-04/05/07/08/09/14 | List; `?status` filter; valid status update; idempotent repeat; invalid status 400; unknown id 404 | ✅ |
| CLD-01…07 | Config/sign never return `api_secret`; folder & tag derived server-side (client `folder` ignored); publicId outside folder or with `..` rejected; asset list paginated | ✅ |
| DASH-04 | `/cms/stats` | ✅ |
| Secrets | Cloudinary secret, JWT secret, Firebase private key: 0 occurrences in `client/src`, `client/dist`, `public/`, `api/`, `docs/`; no `.env` ever committed | ✅ |
| Existing tests | `npm test` (mediaOrganization) 4/4 | ✅ |
| Build | `vite build` succeeds | ✅ (size warning, see PERF-01) |

## 4. Features that failed

The full list is in §6 to §11. Summary of verified failures: 9 crash paths, fake persistence on 41 admin screens, blank page on admin refresh, invalid order transitions, no stock restore, negative price/stock accepted, wrong dashboard metrics, stale admin tokens, no login throttling, `costPrice` exposure, inactive products served by id, order-number collisions, CMS enum bypass, wholesale mass assignment.

## 5. Partially implemented features

| Feature | What exists | What's missing |
|---|---|---|
| Product management | Full backend CRUD | Any UI wiring; admin listing of inactive products; restore; image management tied to MediaAsset |
| Category management | Backend create/rename/delete with good validation | UI wiring; `isActive` toggle, `parent`, `image`, `description`, `sortOrder` editing |
| Order management | List + status update API | Detail endpoint, search, pagination, transition rules, stock restoration, UI wiring |
| Media library | Secure signed upload + register + list + delete APIs; used by Banners | Media page is a mock using `URL.createObjectURL` (nothing uploaded) |
| CMS | Banners & announcements working end-to-end | FAQ, blog, homepage-section UIs are mock although APIs exist |
| Wholesale | Enquiry list/status API + an unrouted UI | Routing; everything shown under `/admin/wholesale/*` is static |
| Dashboard | 4 KPI cards + recent orders | Correct aggregation, server-side stats endpoint, date filters, charts tied to data |

---

## 6. Bugs discovered

### ADM-001 — Unhandled async errors crash the whole API process (anonymous trigger)
- **Severity:** Critical
- **Files:** `server/src/routes/products.js:98-111, 144-148`; `orders.js:42-83`; `cms.js:14-164` (every handler); `wholesale.js:24-34`; `contact.js:21-24`; `users.js` (all handlers); `auth.js:123-127`
- **APIs:** verified crashes on `GET /api/products/:id`, `DELETE /api/products/:id`, `PATCH /api/orders/:id/status`, `GET /api/orders/my/:id`, `POST /api/cms/banners`, `PUT /api/cms/banners/:id`, `POST /api/cms/announcements`, `POST /api/cms/blogs` (dup slug), `PATCH /api/wholesale/enquiries/:id/status`
- **Steps:** `curl http://<api>/api/products/abc` (no auth needed), then `curl http://<api>/api/health`.
- **Expected:** 400/404 JSON; server keeps running.
- **Actual:** no response (socket hang-up); the Node process exits with `CastError: Cast to ObjectId failed for value "abc"`. Missing required fields (e.g. a banner with no title) or duplicate blog slugs crash it the same way (`ValidatorError`, `E11000`). On a long-running host the API stays down until restarted. On Vercel (inferred, not tested), each hit kills the function instance and drops its in-flight requests.
- **Fix:** Upgrade to Express 5 (native async error propagation), or wrap every async handler (`const ah = fn => (req,res,next) => Promise.resolve(fn(req,res,next)).catch(next)`). Validate `:id` with `mongoose.isValidObjectId`. Have the central error handler map `CastError` → 400, `ValidationError` → 400 and `11000` → 409. Optionally add `process.on('unhandledRejection')` logging as a safety net, but not as the fix.

### ADM-002 — Most admin screens are mock UIs that report fake success
- **Severity:** Critical
- **Files:** `client/src/pages/admin/AdminProductsPage.jsx:5,140,231-233`, `AdminProductFormPage.jsx:10-18,112-120`, `products/AdminCategoriesPage.jsx:185-218`, `products/AdminInventoryPage.jsx:221-236`, `AdminOrdersPage.jsx:5,272-285`, `customers/AdminCustomersPage.jsx:5,282`, `AdminMediaPage.jsx:226-243`, plus the other pages listed in §2.3
- **Steps (verified in browser):** Log in as admin → `/admin/products/new` → click **Save & Publish**.
- **Expected:** `POST /api/products`; product appears in DB and storefront.
- **Actual:** **0 network requests**. Toast `Product "Golden Zari Lace Trim" saved and published successfully!` → redirect to `/admin/products`, which lists hardcoded products (none of the 16 DB products appear). The edit route ignores `:id` and always shows "Golden Zari Lace Trim". Orders/Customers pages likewise show none of the DB orders/customers. Media "upload" only creates `blob:` URLs. Deleting, status cycling and stock edits change only local state and are lost on refresh.
- **Fix:** Wire each screen to the API (load via `api()`, mutate via API, reload, then show success only after a 2xx). Until that's done, put a visible "Demo data" banner on these screens or hide them, so an operator never believes a change was saved.

### ADM-003 — Refresh or deep link to any `/admin/*` route renders a blank page
- **Severity:** Critical
- **File:** `client/src/components/admin/AdminLayout.jsx:66-89`
- **Steps (verified):** Log in as admin → open `http://<site>/admin` (or `/admin/orders`) directly, or press F5 on any admin page.
- **Expected:** Admin panel renders after the auth check.
- **Actual:** Blank page (`#root` has 0 children). Console: *"An error occurred in the `<AdminLayout>` component."* The first render returns `null` while `loading` (3 hooks); the next render calls 7 more `useState` plus a `useEffect` → React "rendered more hooks" error. With no error boundary, the entire app unmounts. In-app navigation (e.g. from the storefront after login) works because `loading` is already `false`. The same mismatch is expected when the user is cleared while inside admin (inferred).
- **Fix:** Move every `useState`/`useEffect` above the `if (loading)` / `if (!isAdmin)` returns (or split into a `<RequireAdmin>` guard plus an inner layout component). Add an error boundary around `<Outlet/>`.

### ADM-004 — Dashboard KPIs are miscalculated
- **Severity:** High
- **File:** `client/src/pages/admin/AdminDashboard.jsx:10-26`; `server/src/routes/orders.js:67-72`
- **Steps (verified):** Test DB had 4 orders: all COD/unpaid, 1 cancelled-then-moved-to-pending, plus 16 active products.
- **Expected:** Revenue counts only paid (or delivered) non-cancelled orders; Products = 16.
- **Actual:** "Total Sales ₹3,973" (sum of every order, including cancelled and unpaid COD); "Products 6" (the length of the `?limit=6` response); all figures are capped by `GET /orders` `.limit(200)`. Fetch errors are unhandled (no `.catch`), and the cards silently show 0.
- **Fix:** Add `GET /api/admin/stats` using `countDocuments` / `$group` aggregation with explicit revenue rules (`paymentStatus:'paid'`, `status ≠ cancelled`) and a date range. Show loading and error states.

### ADM-005 — Cancelling an order never restores stock
- **Severity:** High
- **Files:** `server/src/routes/orders.js:56-65` (customer cancel), `74-83` (admin status)
- **Steps (verified):** Stock 3 → order qty 1 → stock 2 → admin sets `cancelled`.
- **Expected:** Stock back to 3.  **Actual:** Stock stays 2. Every cancellation permanently leaks inventory.
- **Fix:** In a transaction, when moving into `cancelled` from a stock-holding state, `$inc` stock back for each line. Make sure it runs only once (see ADM-006).

### ADM-006 — No order status transition rules
- **Severity:** High
- **File:** `server/src/routes/orders.js:74-83`
- **Steps (verified):** `processing → cancelled → delivered → pending` all return 200.
- **Expected:** Terminal states (`cancelled`, `delivered`) are immutable, and only forward transitions are allowed.
- **Actual:** Any status can be set from any status. Combined with ADM-005, a cancelled-then-revived order ships without its stock being re-reserved.
- **Fix:** Add a transition map, e.g. `pending→[processing,cancelled]`, `processing→[shipped,cancelled]`, `shipped→[delivered]`. Use an atomic conditional update (`findOneAndUpdate({_id, status: from}, …)`) and record a status history.

### ADM-007 — Order numbers collide (concurrency and after deletion); DB error leaked to customers
- **Severity:** High
- **File:** `server/src/services/orderService.js:4-7`
- **Steps (verified):** (a) 5 parallel checkouts → 3 fail with `E11000 duplicate key … parisutra_qa.orders index: orderNumber_1 …` returned verbatim in the 400 body. (b) Delete any order → the next checkout fails permanently with E11000, because `countDocuments()+1` reuses an existing number.
- **Expected:** Unique, monotonic numbers; no internal DB errors exposed.
- **Fix:** Use an atomic counter document (`findOneAndUpdate({_id:'order'},{$inc:{seq:1}},{upsert:true,new:true})`) or a random/ULID suffix. Return a generic error message.

### ADM-008 — Admin JWT keeps its role for 7 days after demotion or deletion; logout is client-side only
- **Severity:** High
- **Files:** `server/src/middleware/auth.js:4-25`, `routes/auth.js:9-13`; `client/src/context/AuthContext.jsx:17-23`
- **Steps (verified):** Log in as admin #2 → set role to `customer` in DB → `GET /api/orders` with the old token → **200**. Delete the user → `GET /api/contact` → **200**.
- **Expected:** 403/401 immediately.
- **Actual:** Access continues until the token expires (7 days). Logout only deletes `localStorage`, so a copied token stays valid.
- **Fix:** In `adminRequired`, load the user (`User.findById(req.userId).select('role tokenVersion')`) and check role from the DB. Add a `tokenVersion` (or `passwordChangedAt`) claim to support revocation, and shorten admin token lifetime (e.g. 1–8 h, with refresh).

### ADM-009 — No brute-force protection on login
- **Severity:** High
- **File:** `server/src/routes/auth.js:53-77`, `app.js`
- **Steps (verified):** 25 consecutive wrong passwords for the admin account → all 401, never 429, no lockout.
- **Fix:** Add `express-rate-limit` (per IP and per email) on `/api/auth/*` with backoff or lockout, and log failed attempts. On Vercel, use a shared store (e.g. Upstash/Redis).

### ADM-010 — Product input validation gaps
- **Severity:** High
- **Files:** `server/src/routes/products.js:114-142`; `models/Product.js:20-49`
- **Verified cases:**

| Input | Expected | Actual |
|---|---|---|
| `price:-100` (create) / `price:-1` (update) | 400 | **201 / 200** (stored negative; sorts first in `price-asc`) |
| `stock:-5` | 400 | **201** |
| `price:"abc"` | 400 | 500 "Failed to create product" |
| `category:"abc"` | 400 | 500 |
| `category:<non-existent ObjectId>` | 400 | **201**: product with an orphan category (`populate` → `null`) |
| `unit:"kg"` | 400 | 500 |
| `sku` duplicate of existing | 409 | **201** (no uniqueness) |
| `slug:"../Weird Slug/<b>"` | normalised or 400 | **201**, stored as `../weird slug/<b>` (breaks `/product/:slug` URLs) |
| 20,000-char title | 400 | **201** |
| `price:0` | 400 with specific message | 400, but message says "Title, price, and category are required" |
- **Fix:** Add a schema validation layer (zod/joi/celebrate) with an explicit whitelist. Add `min: 0` on price/stock/comparePrice, `maxlength`s, `unique` + `sparse` on `sku`, and a category existence check. Always run `slugify()` on client-supplied slugs. Return 400/409 from the error mapper (see ADM-001).

### ADM-011 — Required admin APIs are missing
- **Severity:** High
- **Verified 404s:** `GET /api/users` (customer list), `GET /api/users/:id`, `GET /api/orders/:id` (admin order detail). The admin order list has no `pagination`/`q` support (`?q=…&page=2` ignored). There is no way for an admin to list inactive (soft-deleted) products or restore them (PROD-28).
- **Impact:** Phase 6 (customers) and the order-detail, search and pagination parts of Phase 5 cannot be implemented in the UI without new endpoints.
- **Fix:** Add admin-scoped endpoints with projection (never return password hash or firebaseUid), server-side pagination/search (escaped regex or text index), and `includeInactive` for products.

### ADM-012 — Stock check and deduction are not atomic (oversell race)
- **Severity:** High (code-verified; not reproduced because ADM-007 collisions mask the race)
- **File:** `server/src/services/orderService.js:13-21, 41-49, 68-89`
- **Detail:** Stock is read in `buildOrderFromItems`, the order is created, and only then is stock decremented via read-modify-`save()`. Two concurrent orders can both pass the check, so stock can go negative. A failure between `Order.create` and `deductStock` leaves the two inconsistent.
- **Fix:** Use `Product.updateOne({_id, stock:{$gte:qty}}, {$inc:{stock:-qty}})` per line and check `modifiedCount`, inside a MongoDB transaction together with `Order.create` (Atlas supports transactions).

### ADM-013 — Fractional quantities accepted
- **Severity:** Medium
- **File:** `server/src/services/orderService.js:18`
- **Verified:** qty `1.5` → 201; stock becomes fractional.
- **Fix:** `Number.isInteger(qty) && qty >= 1 && qty <= MAX`; add `validate: Number.isInteger` on the schema.

### ADM-014 — Soft-deleted products still served publicly by id
- **Severity:** Medium
- **File:** `server/src/routes/products.js:107-111`
- **Verified:** After `DELETE`, `GET /api/products/:id` → 200 with the full document.
- **Fix:** Filter `isActive:true` on the public route; give admin its own route.

### ADM-015 — Category rename breaks storefront URLs; no activate/deactivate
- **Severity:** Medium
- **File:** `server/src/routes/categories.js:52-74`
- **Verified:** Renaming "Laces" → "Laces & Borders" changes slug to `laces-borders`; `GET /api/categories/laces` → 404 (bookmarks, SEO and hardcoded `client/src/data/*` links break). Sending `isActive:false` is silently ignored, and there is no endpoint to deactivate a category although the model and public filters rely on `isActive`.
- **Fix:** Keep the slug stable (or store old slugs and redirect). Add an explicit `isActive`/`sortOrder` update.

### ADM-016 — CMS updates bypass schema validation; upsert creates arbitrary sections
- **Severity:** Medium
- **File:** `server/src/routes/cms.js:74-76, 90-92, 106-108, 121-128, 138-140`
- **Verified:** `PUT /cms/banners/:id {placement:"not-a-placement", status:"bogus"}` → 200 and persisted (no `runValidators`). `PUT /cms/homepage-sections/not-a-key` → 200, creating a document whose key violates the enum (upsert skips the enum check). `DELETE /cms/faqs/<unknown id>` → 200 `{ok:true}`.
- **Fix:** Add `runValidators: true` on every `findByIdAndUpdate`, whitelist the key before upserting, and return 404 for unknown ids.

### ADM-017 — Banner/Announcements UI: no error handling or loading states
- **Severity:** Medium
- **Files:** `client/src/pages/admin/cms/AdminBannersPage.jsx:53-74`, `AdminContactMessagesPage.jsx:8-10`, `AdminDashboard.jsx:10-13`
- **Detail:** `save`/`remove`/`load` in Banners have no `try/catch`. A failed save leaves the form open with no message (unhandled promise rejection). There are no disabled or loading states, so double-clicking Save can create duplicate banners. Changing the image-category dropdown is required before upload, but nothing explains why upload is disabled beyond small helper text. Announcements handles errors correctly and can serve as the pattern.
- **Fix:** Use a shared mutation helper with `pending` state (disable the submit button), error display and a toast that fires only on success.

### ADM-018 — Wholesale enquiries: unrouted UI, unvalidated status
- **Severity:** Medium
- **Files:** `client/src/pages/admin/AdminWholesalePage.jsx` (not in `App.jsx`); `server/src/routes/wholesale.js:29-34`
- **Verified:** `PATCH …/status {status:"hacked"}` → 200 and persisted.
- **Fix:** Route the page (or merge it into Wholesale → Applications), and add `runValidators: true` or an explicit enum check.

### ADM-019 — Admin "Coupons & Offers" nav item and "Upgrade Plan →" button do nothing
- **Severity:** Low
- **File:** `client/src/components/admin/AdminLayout.jsx`
- **Verified:** "Coupons & Offers" renders as a `<div>` with no link; "Upgrade Plan →" has no handler.

### ADM-020 — No logout control in the admin panel
- **Severity:** Low
- **File:** `client/src/components/admin/AdminLayout.jsx`
- **Verified:** No logout/sign-out text or control in the rendered admin layout. The admin must go to the storefront `/account/logout`.

### ADM-021 — Login with non-string credentials returns 500
- **Severity:** Low
- **File:** `server/src/routes/auth.js:55-59`
- **Verified:** `{"email":{"$ne":null}}` or `{"password":{"$ne":null}}` → 500 "Login failed". Not exploitable: `toLowerCase()` throws before querying, and bcrypt rejects. It should return 400.
- **Fix:** Type-check that both fields are strings.

---

## 7. Security vulnerabilities

| ID | Severity | Issue | Ref |
|---|---|---|---|
| SEC-A | **Critical** | Unauthenticated process crash (DoS) via malformed ObjectId | ADM-001 |
| SEC-B | High | Revoked or deleted admins keep access for up to 7 days; no server-side logout | ADM-008 |
| SEC-C | High | No login rate limiting or lockout | ADM-009 |
| SEC-D | Medium | **`costPrice` (purchase cost / margin) exposed publicly** by `GET /api/products` and `/api/products/:id` (verified) | below |
| SEC-E | Medium | Mass assignment on admin product create/update and all CMS create/update (`req.body` passed straight to Mongoose). Verified `rating:5, reviewCount:99999` accepted. Admin-only, so mainly an integrity risk if an admin session is hijacked. | below |
| SEC-F | Medium | Public `POST /api/wholesale/enquiries` spreads `req.body`: anonymous users can set `status:"closed"` (verified) and attach any `user` id | below |
| SEC-G | Medium | Query-operator injection in public product filters: `?category[$ne]=<id>` reaches Mongo as an operator (verified). The same pattern applies to `status` in `/orders` and `/orders/my`. Limited impact today (still scoped by `isActive` or user), but unsafe. | below |
| SEC-H | Medium | Unescaped user input in `new RegExp(req.query.q)` (verified 500 on `q=(`; ReDoS-prone patterns run on the DB) | `products.js:70-80` |
| SEC-I | Low | CORS reflects any `https://*.vercel.app` origin with `credentials:true` (verified with `attacker-site.vercel.app`). Auth uses Bearer tokens rather than cookies, so impact is limited. | `app.js:33-37` |
| SEC-J | Low | No security headers (`X-Content-Type-Options` missing; `X-Powered-By: Express` present, verified) | `app.js` |
| SEC-K | Low | Error details leak: the global handler returns `err.message` whenever `VERCEL` is unset; `/auth/google` returns `err.message` and `err.code` (commit ff44bbe); E11000 text reaches customers (ADM-007) | `app.js:88-93`, `auth.js:115-119` |
| SEC-L | Low | JWT stored in `localStorage` (XSS-readable). React escaping currently mitigates this; consider httpOnly cookies plus CSRF protection. | `api/client.js:15` |
| SEC-M | Low | Banner `ctaLink` accepts `javascript:` (verified stored). Rendered through React Router `<Link>`; React 19 blocks `javascript:` URLs, so not exploitable today. Validate to relative paths or https anyway. | `cms.js:70` |
| SEC-N | Info | Google sign-in links to an existing local account by verified email. This is acceptable because `email_verified` is enforced, but note that an admin whose email is a Google account can always log in via Google. | `auth.js:96-110` |

**Fixes:**
- **SEC-D:** Exclude `costPrice` with `select('-costPrice')` on public routes (or `select:false` in the schema).
- **SEC-E / SEC-F:** Whitelist allowed fields per route.
- **SEC-G:** Coerce query values with `String(...)` and enable `mongoose.set('sanitizeFilter', true)` or use `express-mongo-sanitize`.
- **SEC-H:** Escape the search input (`q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')`) and cap its length.

**Verified secure:**
- Server-side RBAC on all admin routes.
- Rejection of forged, expired and `alg:none` tokens.
- Cloudinary secret never sent to the client.
- Upload folder and tag cannot be chosen by the client.
- Uploaded assets are re-validated (format, size, tag, cloud host) before registration.
- No secrets in the bundle or in git history.
- Passwords hashed with bcrypt (cost 12) and `select:false`.

---

## 8. API issues (summary per endpoint)

| Endpoint | Validation | Invalid id | Error mapping | Notes |
|---|---|---|---|---|
| POST/PUT `/products` | ❌ weak (ADM-010) | PUT → 500; DELETE → **crash** | 500 for client errors | mass assignment |
| GET `/products/:id` (public) | — | **crash** | — | serves inactive; leaks costPrice |
| `/categories` admin | ✅ good | ✅ 404 | ✅ 409 on dup | best-implemented router |
| GET `/orders` | `status` not type-checked | — | — | cap 200, no pagination/search |
| PATCH `/orders/:id/status` | enum ✅, transitions ❌ | **crash** | — | no stock restore |
| `/cms/*` | none on update | **crash** | none (no try/catch anywhere) | `DELETE` always `{ok:true}` |
| `/wholesale/enquiries/:id/status` | ❌ | **crash** | — | |
| `/uploads/*` | ✅ | ✅ 404 | ✅ via `next(err)` | well designed |
| `/contact` GET | — | — | no try/catch | cap 100, no read/replied update |

## 9. Database issues

1. **No referential integrity for `Product.category`.** Non-existent category ids are accepted (ADM-010). Category deletion is correctly blocked when products exist.
2. **Missing constraints:** `min:0` on price/stock, `maxlength` on strings, unique `sku`, integer `quantity`.
3. **Order numbers** derived from `countDocuments` (ADM-007).
4. **No transactions** around order creation and stock deduction, cancellation and restoration, or payment verification and order creation (ADM-012).
5. **Payment verify race** (out of admin scope; code-verified only, payments were not exercised): two concurrent `/payments/razorpay/verify` calls for the same intent can both pass the `status:'pending'` lookup and create two orders. Fix with `findOneAndUpdate({_id, status:'pending'}, {status:'processing'})`.
6. **Indexes:**
   - Present: text index on products, `{category, isActive}`, unique slugs/emails/publicIds.
   - Missing: `Order.createdAt`, `Order.status`, `Order.user`, which list/sort/filter queries will need at scale.
   - No TTL index on `PaymentIntent.expiresAt`, so abandoned intents accumulate.
7. **Stale-data risk:** `Order.items` snapshot title, price and image (good). However, `paymentMethod`/`paymentStatus` for COD are never updated by any admin flow (no "mark paid"), so revenue can never be computed correctly from data (ADM-004).

## 10. Cloudinary integration issues

| ID | Severity | Issue |
|---|---|---|
| CLD-A | Medium | **Orphaned uploads.** Upload goes browser → Cloudinary first. If `POST /uploads/assets` fails (network, validation, tab closed), the file stays in Cloudinary with no DB record. Only the invalid-file path cleans up (`uploads.js:151-153`). |
| CLD-B | Medium | **Replaced images are never deleted.** Banners store a raw `imageUrl`; replacing it leaves the old asset in Cloudinary and in `MediaAsset`. Products store `images[].url` strings with no `MediaAsset` link, so product image replacement cannot be cleaned up either. |
| CLD-C | Medium | **Deleting a MediaAsset doesn't check usage** (`uploads.js:181-198`): banners and products referencing that URL become broken images. |
| CLD-D | Low | The upload signature does not constrain `allowed_formats`, `max_file_size` or `resource_type`. The server re-validates afterwards and destroys invalid files, so the residual risk is wasted storage. A signature also stays reusable for its validity window. Restricting these through a signed upload preset would enforce limits at Cloudinary. |
| CLD-E | Info | The Media Library page (`AdminMediaPage.jsx`) is mock: "uploads" are `blob:` URLs in memory. Only the Banners screen performs real uploads. |
| ✅ | — | Secret never exposed; folder/tag derived from DB category; `publicId` folder and traversal checks; format/size/tag/host re-verification; unit-tested helpers. |

**Not tested (by design):** real uploads, replacement and deletion against Cloudinary. Fake credentials were used so that no network call reached Cloudinary, and no production media was touched. Recommended next step: run these against a dedicated Cloudinary **test** folder or account.

## 11. UI/UX issues

| ID | Severity | Issue |
|---|---|---|
| UI-01 | Critical | Blank page on refresh or deep link (ADM-003) |
| UI-02 | Critical | Fake success toasts on unpersisted actions (ADM-002) |
| UI-03 | Medium | No error states on Dashboard/Banners/Contact; failures look like "no data" |
| UI-04 | Medium | Mock pagination: Products always renders page buttons 1–5 regardless of data (`AdminProductsPage.jsx:547-559`) |
| UI-05 | Low | Native `window.confirm()` for deletes (Banners, Announcements, Products, Categories); inconsistent with the custom UI and blocks automation |
| UI-06 | Low | No admin logout (ADM-020); dead "Coupons & Offers" and "Upgrade Plan" (ADM-019) |
| UI-07 | Low | Banners form defaults `imageUrl` to `/images/product-1.jpg`, so a banner can be saved with a placeholder image unnoticed |

**Not tested:** tablet and mobile breakpoints, keyboard and screen-reader accessibility, and visual regression. The browser session ran at desktop width only. The layout uses Tailwind responsive classes, but responsive behaviour was **not** verified.

## 12. Automated test results

| Suite | Result |
|---|---|
| Existing `npm test` (`server/src/utils/mediaOrganization.test.js`) | **4 / 4 pass**; no regressions. It is the project's only test file. |
| QA black-box API suite (isolated DB) | **156 checks: 102 pass, 54 fail, 9 crashes** |
| Browser checks (isolated stack, desktop) | 7 checks: unauth redirect ✅; refresh crash ❌; in-app nav ✅; dashboard numbers ❌; product save persistence ❌; product/order/customer lists use DB ❌ ×3 |
| Production build | ✅ builds; single 1.96 MB JS chunk |

**Test infrastructure:** There is no Jest/Vitest/Supertest/RTL/Playwright in the project. Per the read-only rule, no test framework was added to the repo. The suite lives outside the repo (`run.mjs`, `server.mjs` in this session's scratch directory) and uses only Node 22 built-ins plus the project's existing dependencies. **After you approve the audit**, I recommend converting it into `server/test/*.test.js` (`node:test` + Supertest + mongodb-memory-server) so it runs in CI. Tests that currently fail document the bugs above and should be kept failing until fixed, never weakened.

## 13. Performance concerns

| ID | Issue |
|---|---|
| PERF-01 | One 1.96 MB (331 KB gzip) JS bundle. All ~33k lines of admin pages and their mock data ship to every storefront visitor. Lazy-load `/admin/*` with `React.lazy` and split vendor chunks. |
| PERF-02 | The dashboard downloads up to 200 full order documents to compute 4 numbers. Use a server aggregation. |
| PERF-03 | Order creation does N sequential `findById` reads plus N `save()` calls. Use `$in` and `bulkWrite`. |
| PERF-04 | Every request awaits `connectDB()` middleware (cached, fine). The Vercel function `maxDuration: 10s` and the 15s `serverSelectionTimeoutMS` can produce timeouts on cold Atlas connections. |
| PERF-05 | Missing order indexes (see §9). |

## 14. Missing functionality

- Real admin product list, create, edit and delete UI; image gallery management; restore of deleted products
- Category UI; category activate/deactivate, image, description, parent, ordering
- Order detail view, search, pagination, date filters, status history, invoice/shipping info, "mark COD paid", refunds (UI) and returns (no backend)
- Customer list, detail and order history (no backend)
- Reviews moderation (no `Review` model; `rating`/`reviewCount` are editable plain fields)
- Inventory movements / audit log
- Reports, analytics, exports (all static)
- Coupons, loyalty, customer groups, email marketing (no backend)
- Wholesale customers, quotes, price lists, credit (no backend)
- Admin activity / audit log; admin user management (roles are only settable via the DB or the seed script)
- Error boundary; global toast and notification system tied to real API results

## 15. Recommended fix order

1. **ADM-001**: async error handling + ObjectId validation + error mapper (removes all 9 crash paths).
2. **ADM-003**: move hooks above the early returns in `AdminLayout`; add an error boundary.
3. **ADM-002**: label mock screens as demo data right away, then wire Products → Categories → Orders → Media to the existing APIs, in that order.
4. **ADM-005 / 006 / 007 / 012 / 013**: order integrity (transitions, stock restore, atomic stock, counter-based numbers, integer quantities) in one transactional `orderService` change.
5. **ADM-008 / 009**: role check from the DB, token revocation, login rate limiting.
6. **ADM-010, SEC-D/E/F/G/H**: request validation layer, field whitelists, `costPrice` projection, filter sanitisation, regex escaping.
7. **ADM-004 / 011**: admin stats, customer and order-detail endpoints.
8. **ADM-016**: CMS `runValidators`, then Cloudinary lifecycle (CLD-A/B/C), then UX polish and bundle splitting.

---

## Appendix A — Tested vs. untested

| Area | Tested (dynamically) | Code review only | Not tested |
|---|---|---|---|
| Auth | Password login, bad/empty creds, token tampering/expiry, RBAC on 25 endpoints, demotion/deletion, brute force, refresh behaviour | Google/Firebase flow, logout | Real Google sign-in (would need live Firebase), Firebase outage |
| Products | Create/update/delete/search/sort/paginate via API | Admin UI (mock) | Real image upload for products (no UI path exists) |
| Categories | Full API | — | UI (mock) |
| Orders | COD creation, list, filter, transitions, cancel, concurrency, number reuse | Stock race, payment verify race | Razorpay (never called), refunds (none exist) |
| Customers | Confirmed no API exists | Mock UI | — |
| Dashboard | Numbers cross-checked against DB | — | Date filters/charts (none wired) |
| Cloudinary | Config, signing, folder/publicId validation, auth | Orphan/replace/delete lifecycle | Real upload, replace, delete (avoided the live account) |
| CMS | Banners/announcements/blogs/FAQs/sections API incl. failure cases | Banner UI save/error paths | — |
| UI | Desktop: redirect, refresh, navigation, links, product save, list data sources | Remaining mock handlers | Tablet/mobile, slow network, backend-down UI, a11y |
| Edge cases | Invalid ObjectId, long strings, malformed JSON, double requests (concurrency) | Double-click submit | Large-volume (10k products) load test |

## Appendix B — Safety statement

- No production database, Cloudinary account, Razorpay account or Firebase project was contacted with credentials or write operations. All writes went to a throwaway local MongoDB that was shut down after testing.
- The secret scan compared values locally and printed counts only; no secret values appear in this report.
- No source, env, config or git changes were made. Nothing was committed or pushed.
