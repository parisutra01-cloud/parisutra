// Guards that keep the test suite away from production databases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeTestMongoUri } from '../helpers/harness.js';

test('accepts a local test database', () => {
  assert.equal(assertSafeTestMongoUri('mongodb://127.0.0.1:27017/parisutra_test'), 'mongodb://127.0.0.1:27017/parisutra_test');
  assert.ok(assertSafeTestMongoUri('mongodb://localhost:27999/my_test_db?directConnection=true'));
});

test('refuses Atlas / SRV URIs', () => {
  assert.throws(() => assertSafeTestMongoUri('mongodb+srv://u:p@cluster0.abcd.mongodb.net/parisutra_test'), /SRV/);
  assert.throws(() => assertSafeTestMongoUri('mongodb://u:p@cluster0-shard-00-00.abcd.mongodb.net:27017/parisutra_test'), /Atlas host/);
});

test('refuses non-local hosts and non-test database names', () => {
  assert.throws(() => assertSafeTestMongoUri('mongodb://db.example.com:27017/parisutra_test'), /non-local/);
  assert.throws(() => assertSafeTestMongoUri('mongodb://127.0.0.1:27017/arc_legacy'), /must contain "test"/);
  assert.throws(() => assertSafeTestMongoUri(''), /empty/);
});
