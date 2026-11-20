import { asyncRouter } from '../utils/asyncRouter.js';
import mongoose from 'mongoose';
import { v2 as cloudinary } from 'cloudinary';
import { authRequired, adminRequired } from '../middleware/auth.js';
import { Category } from '../models/Category.js';
import { MediaAsset } from '../models/MediaAsset.js';
import { Product } from '../models/Product.js';
import { Banner } from '../models/Banner.js';
import { BlogPost } from '../models/BlogPost.js';
import { HomepageSection } from '../models/HomepageSection.js';
import {
  ALLOWED_IMAGE_FORMATS,
  MAX_IMAGE_BYTES,
  buildMediaLocation,
  publicIdMatchesFolder,
  secureUrlMatchesCloud,
} from '../utils/mediaOrganization.js';

const router = asyncRouter();

function configureCloudinary() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
    return false;
  }
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
  });
  return true;
}

/** Lists where an image URL is referenced (products, banners, categories, blog posts, homepage sections). */
async function imageUsage(url) {
  const [products, banners, categories, blogs, sections] = await Promise.all([
    Product.countDocuments({ 'images.url': url }),
    Banner.countDocuments({ imageUrl: url }),
    Category.countDocuments({ image: url }),
    BlogPost.countDocuments({ coverImage: url }),
    HomepageSection.countDocuments({ imageUrl: url }),
  ]);
  return [
    [products, 'product'], [banners, 'banner'], [categories, 'category'], [blogs, 'blog post'], [sections, 'homepage section'],
  ].filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}${n > 1 ? 's' : ''}`);
}

async function activeCategory(categoryId) {
  if (!mongoose.isValidObjectId(categoryId)) return null;
  return Category.findOne({ _id: categoryId, isActive: true });
}

router.get('/config', authRequired, adminRequired, (_req, res) => {
  const enabled = configureCloudinary();
  if (!enabled) {
    return res.json({ enabled: false });
  }
  res.json({
    enabled: true,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    folder: process.env.CLOUDINARY_FOLDER || 'parisutra',
    maxBytes: MAX_IMAGE_BYTES,
    formats: [...ALLOWED_IMAGE_FORMATS],
  });
});

router.post('/sign', authRequired, adminRequired, async (req, res, next) => {
  try {
    if (!configureCloudinary()) {
      return res.status(503).json({ message: 'Cloudinary is not configured' });
    }
    const category = await activeCategory(req.body?.categoryId);
    if (!category) {
      return res.status(400).json({ message: 'Select a valid category before uploading' });
    }
    const { folder, tag } = buildMediaLocation(process.env.CLOUDINARY_FOLDER, category.slug);
    const timestamp = Math.round(Date.now() / 1000);
    const paramsToSign = { timestamp, folder, tags: tag };
    const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
    res.json({
      timestamp,
      signature,
      apiKey: process.env.CLOUDINARY_API_KEY,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      folder,
      tags: tag,
      categoryId: category._id,
    });
  } catch (err) {
    next(err);
  }
});

router.get('/assets', authRequired, adminRequired, async (req, res, next) => {
  try {
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(48, Math.max(1, Number.parseInt(req.query.limit, 10) || 24));
    const filter = {};
    if (req.query.category && req.query.category !== 'all') {
      const category = await Category.findOne({ slug: String(req.query.category), isActive: true });
      if (!category) return res.status(404).json({ message: 'Category not found' });
      filter.category = category._id;
    }
    const [assets, total] = await Promise.all([
      MediaAsset.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('category', 'name slug'),
      MediaAsset.countDocuments(filter),
    ]);
    res.json({
      assets,
      page,
      limit,
      total,
      pages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
});

router.post('/assets', authRequired, adminRequired, async (req, res, next) => {
  try {
    if (!configureCloudinary()) {
      return res.status(503).json({ message: 'Cloudinary is not configured' });
    }
    const category = await activeCategory(req.body?.categoryId);
    if (!category) {
      return res.status(400).json({ message: 'Select a valid category before uploading' });
    }
    const publicId = String(req.body?.publicId || '');
    const { folder, tag } = buildMediaLocation(process.env.CLOUDINARY_FOLDER, category.slug);
    if (!publicIdMatchesFolder(publicId, folder)) {
      return res.status(400).json({ message: 'Upload does not belong to the selected category' });
    }

    const existing = await MediaAsset.findOne({ publicId }).populate('category', 'name slug');
    if (existing) {
      if (String(existing.category?._id || existing.category) !== String(category._id)) {
        return res.status(409).json({ message: 'This file is already assigned to another category' });
      }
      return res.json({ asset: existing });
    }

    let resource;
    try {
      resource = await cloudinary.api.resource(publicId, { resource_type: 'image' });
    } catch {
      const error = new Error('Uploaded file was not found in Cloudinary');
      error.status = 400;
      throw error;
    }

    const format = String(resource.format || '').toLowerCase();
    const bytes = Number(resource.bytes || 0);
    const tags = (Array.isArray(resource.tags) ? resource.tags : String(resource.tags || '').split(','))
      .map((item) => String(item).trim())
      .filter(Boolean);
    const invalid =
      !ALLOWED_IMAGE_FORMATS.has(format) ||
      bytes <= 0 ||
      bytes > MAX_IMAGE_BYTES ||
      !tags.includes(tag) ||
      !secureUrlMatchesCloud(resource.secure_url, process.env.CLOUDINARY_CLOUD_NAME);

    if (invalid) {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'image' }).catch(() => {});
      return res.status(400).json({ message: 'File type, size, or category tag is not allowed' });
    }

    try {
      const asset = await MediaAsset.create({
        publicId: resource.public_id,
        secureUrl: resource.secure_url,
        category: category._id,
        folder,
        tag,
        format,
        bytes,
        resourceType: 'image',
      });
      await asset.populate('category', 'name slug');
      res.status(201).json({ asset });
    } catch (err) {
      if (err?.code === 11000) {
        const asset = await MediaAsset.findOne({ publicId: resource.public_id }).populate('category', 'name slug');
        return res.json({ asset });
      }
      throw err;
    }
  } catch (err) {
    next(err);
  }
});

router.delete('/assets/:id', authRequired, adminRequired, async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(404).json({ message: 'Media not found' });
    }
    const asset = await MediaAsset.findById(req.params.id);
    if (!asset) return res.status(404).json({ message: 'Media not found' });
    // Never destroy an image that is still shown somewhere (would leave broken images on the site).
    const usage = await imageUsage(asset.secureUrl);
    if (usage.length) {
      return res.status(409).json({ message: `This image is still used by: ${usage.join(', ')}. Remove it there first.` });
    }
    if (configureCloudinary()) {
      await cloudinary.uploader.destroy(asset.publicId, { resource_type: 'image' }).catch((err) => {
        console.error('Cloudinary delete failed:', err.message);
      });
    }
    await asset.deleteOne();
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
