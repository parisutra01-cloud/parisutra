import mongoose from 'mongoose';
import { slugify } from './slugify.js';
import { validateCategoryName } from './mediaOrganization.js';
import { isAllowedImageUrl } from './productInput.js';

/**
 * Validation + whitelisting for admin category writes. Only the fields below can be written;
 * previousSlugs, timestamps and _id are server-controlled.
 */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_DESCRIPTION = 1000;
const MAX_SORT_ORDER = 100000;

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** Same rules the storefront URL needs: lowercase letters, digits, single hyphens. */
export function toCategorySlug(text) {
  return slugify(String(text)).replace(/_/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function parseCategoryInput(body, { partial = false } = {}) {
  const data = {};
  const errors = {};
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);

  if (has('name') || !partial) {
    if (typeof input.name !== 'string' && input.name !== undefined) errors.name = 'name must be text';
    else {
      const checked = validateCategoryName(input.name);
      if (checked.ok) data.name = checked.name;
      else errors.name = checked.message;
    }
  }

  if (has('slug') && !isBlank(input.slug)) {
    if (typeof input.slug !== 'string') errors.slug = 'slug must be text';
    else {
      const slug = toCategorySlug(input.slug);
      if (!slug || slug.length > 60 || !SLUG_PATTERN.test(slug)) {
        errors.slug = 'slug must be 1–60 lowercase letters, numbers and hyphens';
      } else data.slug = slug;
    }
  }

  if (has('description')) {
    if (isBlank(input.description)) data.description = '';
    else if (typeof input.description !== 'string') errors.description = 'description must be text';
    else if (input.description.trim().length > MAX_DESCRIPTION) {
      errors.description = `description must be at most ${MAX_DESCRIPTION} characters`;
    } else data.description = input.description.trim();
  }

  if (has('image')) {
    if (isBlank(input.image)) data.image = '';
    else if (!isAllowedImageUrl(input.image)) {
      errors.image = 'image must be an uploaded Cloudinary image or a /images/ path';
    } else data.image = input.image;
  }

  if (has('parent')) {
    if (isBlank(input.parent)) data.parent = null;
    else if (typeof input.parent !== 'string' || !mongoose.isValidObjectId(input.parent)) {
      errors.parent = 'parent must be a valid category id';
    } else data.parent = input.parent;
  }

  if (has('sortOrder')) {
    const n = typeof input.sortOrder === 'number' ? input.sortOrder
      : typeof input.sortOrder === 'string' && /^-?\d+$/.test(input.sortOrder.trim()) ? Number(input.sortOrder) : NaN;
    if (!Number.isInteger(n) || n < 0 || n > MAX_SORT_ORDER) {
      errors.sortOrder = `display order must be a whole number from 0 to ${MAX_SORT_ORDER}`;
    } else data.sortOrder = n;
  }

  if (has('isActive')) {
    if (typeof input.isActive !== 'boolean') errors.isActive = 'isActive must be true or false';
    else data.isActive = input.isActive;
  }

  return { data, errors };
}
