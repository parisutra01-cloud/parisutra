import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALLOWED_IMAGE_FORMATS,
  buildMediaLocation,
  publicIdMatchesFolder,
  secureUrlMatchesCloud,
  validateCategoryName,
} from './mediaOrganization.js';

test('builds a category folder and tag from the configured base', () => {
  const location = buildMediaLocation('parisutra', 'trims-borders');
  assert.deepEqual(location, {
    folder: 'parisutra/trims-borders',
    tag: 'cat_trims_borders',
  });
});

test('rejects folder paths and duplicate-looking names', () => {
  assert.equal(validateCategoryName('../secrets').ok, false);
  assert.equal(validateCategoryName('Laces/Gold').ok, false);
  assert.equal(validateCategoryName('A').ok, false);
  assert.deepEqual(validateCategoryName('  Gota   Patti '), { ok: true, name: 'Gota Patti' });
});

test('does not treat a client path as the category folder', () => {
  assert.throws(() => buildMediaLocation('parisutra', '../admin'), /Invalid category/);
  assert.equal(publicIdMatchesFolder('parisutra/laces/photo', 'parisutra/laces'), true);
  assert.equal(publicIdMatchesFolder('parisutra/laces-extra/photo', 'parisutra/laces'), false);
  assert.equal(publicIdMatchesFolder('parisutra/../laces/photo', 'parisutra/laces'), false);
});

test('accepts only this cloud secure URL', () => {
  assert.equal(
    secureUrlMatchesCloud('https://res.cloudinary.com/demo/image/upload/v1/parisutra/laces/a.jpg', 'demo'),
    true
  );
  assert.equal(secureUrlMatchesCloud('http://res.cloudinary.com/demo/image/upload/a.jpg', 'demo'), false);
  assert.equal(secureUrlMatchesCloud('https://evil.example/demo/image.jpg', 'demo'), false);
  assert.equal(ALLOWED_IMAGE_FORMATS.has('png'), true);
  assert.equal(ALLOWED_IMAGE_FORMATS.has('svg'), false);
});
