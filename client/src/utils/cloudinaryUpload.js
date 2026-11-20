import { api } from '../api/client.js';

/**
 * Secure image upload, same flow as components/CloudinaryUploadField.jsx:
 *   1. the API signs an upload for the category folder (the secret never leaves the server),
 *   2. the browser uploads the file directly to Cloudinary,
 *   3. the API verifies the stored file (type, size, folder, tag) and registers it in the media library.
 */

const DEFAULT_FORMATS = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'avif'];
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export async function getUploadConfig() {
  try {
    return await api('/uploads/config');
  } catch {
    return { enabled: false };
  }
}

/** Returns a user-facing problem with the file, or null when it can be uploaded. */
export function checkImageFile(file, config = {}) {
  const formats = new Set((config.formats || DEFAULT_FORMATS).map((f) => f.toLowerCase()));
  const maxBytes = config.maxBytes || DEFAULT_MAX_BYTES;
  const ext = file.name.split('.').pop()?.toLowerCase();
  if ((ext && !formats.has(ext)) || (file.type && !file.type.startsWith('image/'))) {
    return `"${file.name}" is not a supported image (use JPG, PNG, WEBP, GIF or AVIF).`;
  }
  if (file.size > maxBytes) return `"${file.name}" is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`;
  return null;
}

/** Uploads one image into the given category's folder and returns the registered media asset. */
export async function uploadImage(file, categoryId, config = {}) {
  if (!categoryId) throw new Error('Select a category before uploading images.');
  const problem = checkImageFile(file, config);
  if (problem) throw new Error(problem);

  const sign = await api('/uploads/sign', { method: 'POST', body: JSON.stringify({ categoryId }) });
  const formData = new FormData();
  formData.append('file', file);
  formData.append('api_key', sign.apiKey);
  formData.append('timestamp', String(sign.timestamp));
  formData.append('signature', sign.signature);
  formData.append('folder', sign.folder);
  formData.append('tags', sign.tags);

  let data = {};
  let res;
  try {
    res = await fetch(`https://api.cloudinary.com/v1_1/${sign.cloudName}/image/upload`, { method: 'POST', body: formData });
    data = await res.json().catch(() => ({}));
  } catch {
    throw new Error(`Could not reach the image service to upload "${file.name}". Check your connection and try again.`);
  }
  if (!res.ok) throw new Error(data.error?.message || `Upload of "${file.name}" failed.`);

  const saved = await api('/uploads/assets', {
    method: 'POST',
    body: JSON.stringify({ publicId: data.public_id, categoryId }),
  });
  return saved.asset;
}

/** Deletes a media-library asset that was uploaded but never saved on a product. */
export function discardUploadedAsset(assetId) {
  return api(`/uploads/assets/${assetId}`, { method: 'DELETE' });
}
