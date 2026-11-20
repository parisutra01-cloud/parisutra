import mongoose from 'mongoose';
import { slugify } from './slugify.js';
import { secureUrlMatchesCloud } from './mediaOrganization.js';

/**
 * Validation + whitelisting for admin product writes.
 *
 * Only the fields listed here can be written through the API, which prevents mass assignment
 * (rating, reviewCount, variations, timestamps and _id are server-controlled). Unknown fields are ignored.
 */

export const PRODUCT_UNITS = ['meter', 'pair', 'piece', 'pack'];
export const MAX_IMAGES = 10;

const LIMITS = {
  title: [2, 200],
  shortDescription: [0, 500],
  description: [0, 20000],
  metaTitle: [0, 120],
  metaDescription: [0, 320],
};
const MAX_PRICE = 10_000_000;
const MAX_STOCK = 10_000_000;
const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '' && /^-?\d+(\.\d+)?$/.test(value.trim())) return Number(value);
  return NaN;
}

/** Accepts local storefront assets (/images/...) and Cloudinary URLs of this account. */
export function isAllowedImageUrl(url, cloudName = process.env.CLOUDINARY_CLOUD_NAME) {
  if (typeof url !== 'string' || url.length > 1000) return false;
  if (url.startsWith('/images/')) return !url.includes('..') && !/[\s"'<>\\]/.test(url);
  if (cloudName) return secureUrlMatchesCloud(url, cloudName);
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === 'res.cloudinary.com';
  } catch {
    return false;
  }
}

/**
 * @param {object} body  raw request body
 * @param {{ partial?: boolean }} options  partial=true for updates (only provided fields are validated)
 * @returns {{ data: object, errors: Record<string,string> }}
 */
export function parseProductInput(body, { partial = false } = {}) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const data = {};
  const errors = {};
  const has = (key) => Object.prototype.hasOwnProperty.call(input, key);
  const required = (key) => !partial || has(key);

  // Text fields
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (!has(key)) {
      if (key === 'title' && required(key)) errors.title = 'title is required';
      continue;
    }
    const value = input[key];
    if (value === null && key !== 'title') { data[key] = ''; continue; }
    if (typeof value !== 'string') { errors[key] = `${key} must be text`; continue; }
    const trimmed = value.trim();
    if (key === 'title' && trimmed.length === 0) { errors.title = 'title is required'; continue; }
    if (trimmed.length < min || trimmed.length > max) {
      errors[key] = `${key} must be ${min ? `${min}–` : 'at most '}${max} characters`;
      continue;
    }
    data[key] = trimmed;
  }

  // Slug (optional; derived from title on create when absent)
  if (has('slug') && !isBlank(input.slug)) {
    if (typeof input.slug !== 'string') errors.slug = 'slug must be text';
    else {
      const slug = slugify(input.slug).replace(/_/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!SLUG_PATTERN.test(slug) || slug.length > 200) errors.slug = 'slug may only contain letters, numbers and hyphens';
      else data.slug = slug;
    }
  }

  // SKU (optional; empty string clears it)
  if (has('sku')) {
    if (isBlank(input.sku)) data.sku = undefined;
    else if (typeof input.sku !== 'string') errors.sku = 'sku must be text';
    else if (!SKU_PATTERN.test(input.sku.trim())) errors.sku = 'sku may use letters, numbers, ".", "_", "/" and "-" (max 64)';
    else data.sku = input.sku.trim();
  }

  // Category reference (existence is checked against the database by the route)
  if (has('category') || required('category')) {
    const cat = input.category;
    if (isBlank(cat)) errors.category = 'category is required';
    else if (typeof cat !== 'string' || !mongoose.isValidObjectId(cat)) errors.category = 'category is invalid';
    else data.category = cat;
  }

  // Money
  if (has('price') || required('price')) {
    const price = toNumber(input.price);
    if (isBlank(input.price)) errors.price = 'price is required';
    else if (!Number.isFinite(price)) errors.price = 'price must be a number';
    else if (price <= 0) errors.price = 'price must be greater than 0';
    else if (price > MAX_PRICE) errors.price = 'price is too large';
    else data.price = Math.round(price * 100) / 100;
  }
  for (const key of ['comparePrice', 'costPrice']) {
    if (!has(key)) continue;
    if (isBlank(input[key])) { data[key] = undefined; continue; }
    const value = toNumber(input[key]);
    if (!Number.isFinite(value)) errors[key] = `${key} must be a number`;
    else if (value < 0) errors[key] = `${key} cannot be negative`;
    else if (value > MAX_PRICE) errors[key] = `${key} is too large`;
    else data[key] = Math.round(value * 100) / 100;
  }

  // Inventory
  for (const key of ['stock', 'lowStockAlert']) {
    if (!has(key)) continue;
    const value = toNumber(input[key]);
    if (isBlank(input[key])) errors[key] = `${key} is required`;
    else if (!Number.isInteger(value)) errors[key] = `${key} must be a whole number`;
    else if (value < 0) errors[key] = `${key} cannot be negative`;
    else if (value > MAX_STOCK) errors[key] = `${key} is too large`;
    else data[key] = value;
  }

  if (has('unit')) {
    const unit = typeof input.unit === 'string' ? input.unit.trim().toLowerCase() : '';
    if (!PRODUCT_UNITS.includes(unit)) errors.unit = `unit must be one of: ${PRODUCT_UNITS.join(', ')}`;
    else data.unit = unit;
  }

  for (const key of ['trackStock', 'isActive', 'isFeatured', 'isNewArrival']) {
    if (!has(key)) continue;
    if (typeof input[key] !== 'boolean') errors[key] = `${key} must be true or false`;
    else data[key] = input[key];
  }

  // Attribute lists used by storefront filters
  for (const key of ['material', 'colors', 'styles']) {
    if (!has(key)) continue;
    const list = input[key];
    if (!Array.isArray(list) || list.length > 20 || list.some((v) => typeof v !== 'string' || v.trim().length === 0 || v.trim().length > 50)) {
      errors[key] = `${key} must be a list of up to 20 short labels`;
      continue;
    }
    data[key] = [...new Set(list.map((v) => v.trim()))];
  }

  // Images
  if (has('images')) {
    const list = input.images;
    if (!Array.isArray(list)) errors.images = 'images must be a list';
    else if (list.length > MAX_IMAGES) errors.images = `a product can have at most ${MAX_IMAGES} images`;
    else {
      const images = [];
      for (const img of list) {
        const url = typeof img === 'string' ? img : img?.url;
        if (!isAllowedImageUrl(url)) { errors.images = 'images must be uploaded images (Cloudinary) or /images/... paths'; break; }
        if (images.some((i) => i.url === url)) continue;
        images.push({ url, isMain: Boolean(typeof img === 'object' && img?.isMain === true) });
      }
      if (!errors.images) {
        const mainIndex = images.findIndex((i) => i.isMain);
        images.forEach((i, idx) => { i.isMain = idx === (mainIndex === -1 ? 0 : mainIndex); });
        data.images = images;
      }
    }
  }

  return { data, errors };
}

/** Cross-field rules that need the final (merged) values. */
export function crossFieldErrors(merged) {
  const errors = {};
  if (Number.isFinite(merged.comparePrice) && Number.isFinite(merged.price) && merged.comparePrice > 0 && merged.comparePrice < merged.price) {
    errors.comparePrice = 'compare price must be greater than or equal to the selling price';
  }
  return errors;
}

/** Builds the API error body: a readable summary plus per-field messages. */
export function validationBody(errors) {
  const entries = Object.values(errors);
  const message = entries.length === 1 ? entries[0][0].toUpperCase() + entries[0].slice(1) : `Please fix ${entries.length} fields`;
  return { message, errors };
}
