# Parisutra — Phase 5G.2: Safe Stock Adjustment APIs

Follows `PARISUTRA_INVENTORY_AUDIT.md` (findings INV-A1…A3, recommended architecture §9).
Backend only; the inventory screen is Phase 5G.4.

## Endpoints (admin only: 401 without login, 403 for customers)

### `POST /api/products/:id/stock/adjust` — add or remove units
```json
{ "operation": "add" | "remove", "quantity": 5, "reason": "Delivery received" }
```
200:
```json
{ "product": { "_id": "…", "title": "…", "sku": "SKU-1", "stock": 15, "trackStock": true, "lowStockAlert": 10, "isActive": true },
  "previousStock": 10, "change": 5 }
```
- `add`: `$inc +q`; refused (409) if the result would exceed 10,000,000 or the stored stock is `null`.
- `remove`: `$inc −q` **only where `stock ≥ q`**; otherwise 409 `{ message, currentStock }`. Never negative.

### `POST /api/products/:id/stock/set` — exact count (physical recount)
```json
{ "quantity": 37, "expectedStock": 10, "reason": "Physical recount" }
```
- `$set` **only where stock still equals `expectedStock`** (compare-and-set). If anything changed it
  since the admin looked (a sale, a cancellation, another admin): 409
  `{ "message": "Stock has changed since you looked (now 8). Review it and try again.", "currentStock": 8 }`.

Errors: 400 invalid id / invalid body (`{ message, errors }`), 404 unknown product, 409 as above.

## Atomic strategy
Each operation is a single `findOneAndUpdate` whose filter contains the safety condition, so the check
and the write happen together in MongoDB. Nothing is read and written back. These operations commute with
checkout reservations (`$inc −q`), reservation releases and cancellation restores (`$inc +q`), so no
change is lost. No transaction is needed (one document per operation).

## Semantics
- **Stock tracking:** `trackStock` and `isActive` are never changed. Untracked products can still have
  their stock adjusted (kept for when tracking is turned on); it is not enforced at checkout.
- **Missing stock (legacy):** treated as 0, as everywhere else. `remove` → 409 (0 available); `add`
  creates the value from 0; an exact count matches a missing or `null` value only with
  `expectedStock: 0`. A `null` value cannot be added to: set an exact count first.
- **Precision:** whole units, 0–10,000,000, matching product stock validation and order quantities.
  `expectedStock` is compared only, so it may be the fractional or negative legacy value the admin saw,
  which lets an exact count correct it.
- **Body:** plain JSON object with only the listed fields: operators, extra fields (e.g. `actorId`,
  `stock`, `$set`) and non-numbers are rejected. Reason: required, trimmed, 1–200 characters.
- **Actor:** always the authenticated admin (`req.userId`); never taken from the request.

## Temporary audit trail
Each successful change writes one line to the server log (stdout):
```
[stock-audit] {"event":"stock.manual_change","actorId":"…","productId":"…","operation":"add","quantity":5,"previousStock":10,"newStock":15,"reason":"Delivery received","at":"2026-11-20T…Z"}
```
Contains no customer data, tokens or payment details. This is a **temporary diagnostic trail, not an
inventory history**: logs rotate and are not queryable. The stock movement collection remains deferred.

## Tests
`server/test/api/stock-adjustment.test.js` (SA-01…16) and `server/test/unit/stock-input.test.js`.
Mutation checks: replacing the atomic update with read-then-save makes SA-03/04/05/06/10/12 fail;
removing the compare-and-set condition makes SA-08/09/12/16 fail.

## Not changed / remaining
- `PUT /api/products/:id` still writes `stock` as an absolute value (audit INV-A1/A2); the product form
  fix is Phase 5G.3.
- Razorpay `deductStock` (audit INV-A4) is untouched (Phase 5H).
- No stock movement collection was created.
