# Parisutra — Phase 5G.3: Product Edits No Longer Overwrite Concurrent Stock Changes

Fixes audit findings INV-A1 (stale form save overwrites stock), INV-A2 (stale save erases a
cancellation restore) and the stock part of INV-A3 (two admins, last write wins).
Builds on the Phase 5G.2 compare-and-set (`PARISUTRA_INVENTORY_5G2_REPORT.md`).

## Files changed

| File | Why |
|---|---|
| `server/src/routes/products.js` | `PUT /products/:id`: stock is written only with `expectedStock`, as one conditional update; 409 on a stale value. (Also moved the soft-delete comment back above the delete route; 5G.2 had separated them.) |
| `server/src/utils/stockInput.js` | `parseExpectedStock` extracted from `parseStockSet` so both endpoints validate `expectedStock` identically. |
| `server/src/services/stockAdjustment.js` | `expectedStockFilter` and `stockValue` exported and reused by the product update (one compare-and-set implementation). |
| `client/src/pages/admin/AdminProductFormPage.jsx` | Stock snapshot at load; stock sent only when changed, with `expectedStock`; conflict panel. |
| `client/src/api/client.js` | Errors now also carry the response body (`error.data`), so the form can read `code` and `currentStock`. Additive; existing callers unaffected. |
| `server/test/api/product-edit-stock.test.js` | **New.** PES-01…15 |
| `client/test/admin-product-stock.e2e.test.js` | **New.** PSE-01…09 |
| `server/test/api/products.test.js` | PROD-17 now sends `expectedStock` with its stock change (same assertions). |
| `server/test/api/stock-adjustment.test.js` | SA-16 reproduces the old absolute write directly, and now also asserts that `PUT` refuses stock without `expectedStock`. |
| `server/test/README.md` | Lists the new suites. |

## Request behaviour (`PUT /api/products/:id`, admin only)

| Request | Result |
|---|---|
| No `stock`, no `expectedStock` | Other fields updated; **stock is not in the update at all**. |
| `stock` + `expectedStock` | Applied only if the database stock still equals `expectedStock`. Stock and all other fields go in **one** atomic update. |
| `stock` + `expectedStock`, stock has changed meanwhile | **409** `{ message, code: "STOCK_CONFLICT", currentStock, errors: { stock } }`. Nothing in the request is applied. No retry. |
| `stock` without `expectedStock` | **400** (`errors.expectedStock`). There is no absolute-stock path left. |
| `expectedStock` without `stock` | **400**. |

- **New stock values** follow the existing product rules: whole number, 0–10,000,000, numeric strings accepted as before.
- **`expectedStock`** follows the 5G.2 rule: any finite JSON number. Strings, `null`, objects/operators and booleans are rejected.
- **Unchanged rules:** authorization, the validation and cross-field rules, active-category checks, SKU/slug conflicts, image allowlist, field whitelisting (unknown fields and `$`-keys are ignored) and the response shape (`{ product }`).
- **Audit line:** a successful stock change writes one `[stock-audit]` line with `operation: "product_edit"` and `reason: "Product edit form"` (same temporary trail as 5G.2).

## Compare-and-set and legacy stock

The update is `findOneAndUpdate({ _id, ...expectedStockFilter(expectedStock) }, { $set: … })`. It uses the same filter function as the 5G.2 exact-count endpoint. Nothing is read and saved back with `.save()`.

When no stock change is requested, the filter is just `{ _id }` and `$set` contains no stock. Sales, cancellation restores and stock adjustments are atomic `$inc` updates, so they are never overwritten.

**Missing or `null` stock** is handled exactly as in 5G.2 exact count:
- `expectedStock: 0` matches it.
- Any other expected value gets a 409 with `currentStock: 0`.
- An unrelated edit leaves a missing value missing and a `null` value `null`.

5G.2's refusal to *add* to a `null` stock is unchanged. That applies to the `$inc` endpoint only, not to an exact value.

## Form behaviour

- **Opening a product:** the form records the loaded stock (missing or `null` counts as 0) as the guard value.
- **Untouched stock:** if the field still equals that value (including typed and then changed back), the request contains neither `stock` nor `expectedStock`. Unchanged stock is not validated either, so an old fractional value such as 2.5 no longer blocks unrelated edits.
- **Changed stock:** the request sends `stock` with the new value and `expectedStock` with the value from when the form was opened. A re-fetched or displayed value is never used as the guard.
- **On a 409:** a panel under the stock field says the stock changed while the form was open, shows the value then and now, and says nothing was saved and the other edits are still in the form.
  - Saving again without reviewing gets refused again.
  - The only way forward is the explicit **"Start from current stock (N)"** button. It sets the field and the guard value to N; the admin then enters the intended value and saves.
  - Nothing is resubmitted automatically.
- **Creating a product** is unchanged; the initial stock is sent and validated as before.

## Tests

| Suite | 5G.2 baseline | 5G.3 |
|---|---|---|
| Unit | 44/44 | **44/44** |
| Stable API | 212/212 | **227/227** (+15 PES) |
| Browser | 56/56 | **65/65** (+9 PSE) |
| Regression | 59/72 | **59/72**, the same 13 known failures (AUTH-13/14/15, CUST-01/02/03, WHS-01/02, SEC-I/J/M, CMS-03/07) |
| Client build | ok | **ok** |

- **Stock regressions still pass:** all order and inventory regressions, including ORD-10…18, INV-01…04 and PROD-09b.
- **Repeat runs:** the two new suites plus `admin-products` passed in two further repeat runs (35/35 each).
- **RL-LINKS:** the 5G.2 timing fix is intact.

**Race evidence:**
- "Form open" is the real form load (`GET /products/manage/:id`), followed by the concurrent change, then the save. This is the realistic window of minutes, and it is sequenced deterministically.
- Same-instant races are repeated 10 rounds each:

| Test | Race | Result |
|---|---|---|
| PES-08 | Two admins with the same `expectedStock` | Exactly one 200 and one 409 every round; the loser changed nothing and was told the winner's value |
| PES-14 | Unrelated edit + sale + admin add, all at once | Always 13 (10 − 2 + 5) |
| PES-14 | Stock change vs. sale | Either 200 then 13, or 409 then 8; never a lost sale |
| PES-14 | Unrelated edit vs. cancellation restore | Always 12 |

**Control (PES-15):** reproducing the old write ($set of the form's stock) erases a sale (10 instead of 8). An old-style request is now refused (400), and the new request keeps the sale.

**Mutation checks** (files restored, verified identical with `cmp`):
- **Server guard disabled** (stock accepted without `expectedStock`, no compare-and-set): PES-06, 07, 08, 09, 10, 11 and 15 fail.
- **Form writing stock back and server accepting it** (the full pre-5G.3 behaviour): PSE-01, 02, 03, 05, 06 and 07 fail.
- **Form writing stock back with the server guarded:** 5 browser tests fail, because the save is refused.

## Remaining limitations

- **Other fields are still last-write-wins between two admins** (title, price and so on). Only stock is guarded. A general document version check would be a separate change.
- **There is a millisecond gap** between the route's validation read and the atomic update. Stock is safe in that gap because of the filter. A cross-field rule (`comparePrice ≥ price`) is still checked against that read, as before.
- **Razorpay `deductStock` (INV-A4)** is still non-atomic; that is Phase 5H.
- **The audit trail is still temporary** log lines; there is no stock movement collection.
- **Inventory page** (5G.4) and dashboard stock indicators (5G.5) are not started.

## Confirmations

- **Razorpay/payment code untouched:** `payments.js`, `createOrder` and `deductStock` were not modified.
- **No stock movement collection was created.**
- **No production services were contacted:** only the throwaway local MongoDB replica sets from the test harness, and a local Vite server and headless Chrome with external traffic blocked.
- **Nothing was staged, committed or pushed.** The unrelated uncommitted files (`docs/DEPLOY-VERCEL-SPLIT.md`, `vercel.json`, `index.js`) were not touched.
