# Unique SKU index: migration plan (not yet applied)

## Problem

`POST /api/products` and `PUT /api/products/:id` reject a SKU that another product already uses,
ignoring case (`skuTaken()` in `server/src/routes/products.js`). That check runs in the application.
The `products` collection has **no unique index on `sku`**, so two saves that arrive at the same time can
both pass the check and both be written:

```
request A: skuTaken('LACE-01') → false
request B: skuTaken('lace-01') → false
request A: insert LACE-01
request B: insert lace-01          ← duplicate, no error
```

The window is small, so this needs simultaneous admin saves or an import script. Only the database
can close it.

## Constraints that shape the index

| Fact | Consequence |
|---|---|
| SKU is optional; blank means "no SKU" (the field is unset) | Products without a SKU must not collide with each other, so the index has to be **partial** |
| Uniqueness ignores case (`LACE-01` = `lace-01`) | The index needs a **case-insensitive collation** (strength 2) |
| Older documents may hold `sku: ""`, `sku: null` or values with spaces | Clean these up **before** building the index |
| Existing data may already contain duplicates | The build fails if they do, so they must be resolved first, by a person |
| Mongoose `autoIndex` builds schema indexes at startup and only *logs* a failure | Don't rely on startup: create the index on purpose, and check the result |

## Steps

Run each step on a **staging copy of production data** first. Take a backup (Atlas snapshot or
`mongodump`) before touching production.

### 1. Audit (read-only)

```js
// mongosh, against the target database
db.products.aggregate([
  { $match: { sku: { $type: 'string' } } },
  { $project: { key: { $toLower: { $trim: { input: '$sku' } } }, sku: 1, title: 1, isActive: 1 } },
  { $match: { key: { $ne: '' } } },
  { $group: { _id: '$key', count: { $sum: 1 }, products: { $push: { _id: '$_id', sku: '$sku', title: '$title', isActive: '$isActive' } } } },
  { $match: { count: { $gt: 1 } } },
]);
// Also count values that need normalising:
db.products.countDocuments({ $or: [{ sku: '' }, { sku: null }, { sku: /^\s|\s$/ }] });
```

### 2. Normalise blanks and whitespace (safe, mechanical)

```js
db.products.updateMany({ $or: [{ sku: '' }, { sku: null }, { sku: /^\s+$/ }] }, { $unset: { sku: '' } });
db.products.find({ sku: /^\s|\s$/ }).forEach((p) => db.products.updateOne({ _id: p._id }, { $set: { sku: p.sku.trim() } }));
```

### 3. Resolve duplicates (manual decision)

For each group from step 1, a person decides which product keeps the SKU. The others get a corrected
SKU through the admin product form. **Don't auto-rename SKUs:** they appear on invoices, labels and
supplier records. Run step 1 again until it returns nothing.

### 4. Build the index (online)

```js
db.products.createIndex(
  { sku: 1 },
  {
    name: 'sku_unique_ci',
    unique: true,
    collation: { locale: 'en', strength: 2 },
    partialFilterExpression: { sku: { $type: 'string', $gt: '' } },
  }
);
```

From MongoDB 4.2, index builds hold an exclusive lock only briefly at the start and end, so the store
stays online. If a duplicate slipped in since step 3, the build fails with `E11000` and changes
nothing: fix that duplicate and run it again.

### 5. Ship the matching code change (after the index exists)

- Declare the same index in `server/src/models/Product.js`, with identical name, collation and partial
  filter, so Mongoose doesn't try to build a conflicting one.
- In the create/update `catch`, map `E11000` errors whose `keyPattern` contains `sku` to
  `409 { errors: { sku: 'SKU already exists' } }`. Today every `11000` from these routes is reported
  as a slug conflict.
- Keep the friendly pre-check, but query with the same collation instead of a regex so it uses the index:
  `Product.exists({ sku }).collation({ locale: 'en', strength: 2 })`.
- Add a regression test that fires two simultaneous creates with `LACE-01` / `lace-01` and expects
  exactly one `201` and one `409`.

### Rollback

`db.products.dropIndex('sku_unique_ci')` returns to today's behaviour; no data changes are involved.
The code from step 5 still works without the index.

## Same pattern elsewhere

Category **names** are also unique only through an application check (case-insensitive), so
simultaneous creates could produce two categories with the same name but different slugs. Category
**slugs** are already protected by the existing unique index. The same audit → resolve → collation
index plan applies, using `{ name: 1 }` with `collation: { locale: 'en', strength: 2 }`.
