import 'dotenv/config';
import { connectDB } from './config/db.js';
import { Category } from './models/Category.js';
import { Product } from './models/Product.js';
import { slugify } from './utils/slugify.js';

const categories = [
  {
    name: 'Laces',
    slug: 'laces',
    sortOrder: 1,
    image: '/images/product-2.jpg',
    description: 'Embroidered and beaded laces for blouses, lehengas, and home décor.',
  },
  {
    name: 'Latkans',
    slug: 'latkans',
    sortOrder: 2,
    image: '/images/latkans/prod_1.jpg',
    description: 'Hanging latkans in pearl, bead, tassel, and bridal styles.',
  },
  {
    name: 'Trims & Borders',
    slug: 'trims-borders',
    sortOrder: 3,
    image: '/images/trims-borders/prod_1.jpg',
    description: 'Beaded borders and trims sold by the meter.',
  },
  {
    name: 'Pom Pom Trims',
    slug: 'pom-pom-trims',
    sortOrder: 4,
    image: '/images/pom-pom-trims/prod_1.jpg',
    description: 'Colourful pom pom trims for festive and kidswear edits.',
  },
  {
    name: 'Gota Patti',
    slug: 'gota-patti',
    sortOrder: 5,
    image: '/images/gota-patti/prod_1.jpg',
    description: 'Gota patti borders and motifs in gold and antique finishes.',
  },
  {
    name: 'Embellishments',
    slug: 'embellishments',
    sortOrder: 6,
    image: '/images/embellishments/prod_1.jpg',
    description: 'Motifs, patches, and mirror work for custom outfits.',
  },
];

const products = [
  { title: 'Pearl Beaded Gold Lace', categorySlug: 'laces', price: 320, comparePrice: 399, unit: 'meter', material: ['Pearl', 'Thread'], colors: ['Gold'], styles: ['Traditional'], image: '/images/product-2.jpg', isFeatured: true, stock: 80 },
  { title: 'Golden Zari Lace Trim', categorySlug: 'laces', price: 180, comparePrice: 250, unit: 'meter', material: ['Thread'], colors: ['Gold'], styles: ['Traditional'], image: '/images/product-10.jpg', isNewArrival: true, sku: 'GT-1023', stock: 64 },
  { title: 'Floral Embroidered Lace', categorySlug: 'laces', price: 260, unit: 'meter', material: ['Thread', 'Silk'], colors: ['Maroon'], styles: ['Floral'], image: '/images/provided-floral-lace.jpg', isFeatured: true, stock: 48 },
  { title: 'Crystal Fringe Lace', categorySlug: 'laces', price: 410, unit: 'meter', material: ['Crystal', 'Thread'], colors: ['Gold'], styles: ['Bridal'], image: '/images/provided-crystal-fringe.jpg', isNewArrival: true, stock: 22 },

  { title: 'Red Bridal Fabric Latkan', categorySlug: 'latkans', price: 220, unit: 'pair', material: ['Fabric'], colors: ['Red'], styles: ['Bridal'], image: '/images/latkans/prod_1.jpg', isFeatured: true, isNewArrival: true, stock: 36 },
  { title: 'Pearl Hanging Latkan', categorySlug: 'latkans', price: 180, unit: 'pair', material: ['Pearl'], colors: ['Gold'], styles: ['Traditional'], image: '/images/latkans/prod_2.jpg', isNewArrival: true, stock: 50 },
  { title: 'Golden Bead Tassel Latkan', categorySlug: 'latkans', price: 280, unit: 'pair', material: ['Beads'], colors: ['Gold'], styles: ['Tassel'], image: '/images/latkans/prod_4.jpg', isFeatured: true, stock: 28 },
  { title: 'Kundan Latkan', categorySlug: 'latkans', price: 350, unit: 'pair', material: ['Metal'], colors: ['Gold'], styles: ['Designer'], image: '/images/latkans/prod_6.jpg', stock: 18 },

  { title: 'Floral Zari Border Trim', categorySlug: 'trims-borders', price: 350, unit: 'meter', material: ['Fabric', 'Thread'], colors: ['Gold', 'Red'], styles: ['Traditional'], image: '/images/trims-borders/prod_1.jpg', isFeatured: true, stock: 70 },
  { title: 'Beaded Scallop Border', categorySlug: 'trims-borders', price: 290, unit: 'meter', material: ['Beads'], colors: ['Gold'], styles: ['Scallop'], image: '/images/trims-borders/prod_3.jpg', isNewArrival: true, stock: 40 },
  { title: 'Antique Gold Bead Trim', categorySlug: 'trims-borders', price: 240, unit: 'meter', material: ['Beads', 'Thread'], colors: ['Antique Gold'], styles: ['Traditional'], image: '/images/trims-borders/prod_5.jpg', stock: 55 },
  { title: 'Maroon Velvet Border', categorySlug: 'trims-borders', price: 310, unit: 'meter', material: ['Fabric'], colors: ['Maroon'], styles: ['Bridal'], image: '/images/trims-borders/prod_8.jpg', isFeatured: true, stock: 33 },

  { title: 'Multicolour Ball Pom Pom Trim', categorySlug: 'pom-pom-trims', price: 180, unit: 'meter', material: ['Cotton'], colors: ['Multicolour'], styles: ['Festive'], image: '/images/pom-pom-trims/prod_1.jpg', isFeatured: true, isNewArrival: true, stock: 90 },
  { title: 'Mini Rainbow Pom Pom Lace', categorySlug: 'pom-pom-trims', price: 120, unit: 'meter', material: ['Thread'], colors: ['Multicolour'], styles: ['Plain'], image: '/images/pom-pom-trims/prod_2.jpg', isNewArrival: true, stock: 76 },
  { title: 'Shell and Pom Pom Border', categorySlug: 'pom-pom-trims', price: 280, unit: 'meter', material: ['Cotton'], colors: ['Red'], styles: ['With Shells'], image: '/images/pom-pom-trims/prod_3.jpg', stock: 24 },
  { title: 'Red and Gold Festive Pom Trim', categorySlug: 'pom-pom-trims', price: 200, unit: 'meter', material: ['Silk'], colors: ['Red', 'Gold'], styles: ['Festive'], image: '/images/pom-pom-trims/prod_4.jpg', isFeatured: true, stock: 44 },

  { title: 'Embroidered Gota Border', categorySlug: 'gota-patti', price: 240, unit: 'meter', material: ['Fabric'], colors: ['Antique Gold'], styles: ['Traditional'], image: '/images/gota-patti/prod_1.jpg', isFeatured: true, stock: 60 },
  { title: 'Gota Patti Leaf Trim', categorySlug: 'gota-patti', price: 210, unit: 'meter', material: ['Gota'], colors: ['Gold'], styles: ['Leaf'], image: '/images/gota-patti/prod_2.jpg', isNewArrival: true, stock: 38 },
  { title: 'Bridal Gota Motif Border', categorySlug: 'gota-patti', price: 360, unit: 'meter', material: ['Gota', 'Thread'], colors: ['Gold', 'Red'], styles: ['Bridal'], image: '/images/gota-patti/prod_4.jpg', isNewArrival: true, stock: 20 },
  { title: 'Silver Gota Ribbon Trim', categorySlug: 'gota-patti', price: 190, unit: 'meter', material: ['Gota'], colors: ['Silver'], styles: ['Contemporary'], image: '/images/gota-patti/prod_6.jpg', stock: 52 },

  { title: 'Kundan Motif Patch', categorySlug: 'embellishments', price: 420, unit: 'piece', material: ['Kundan'], colors: ['Gold'], styles: ['Bridal'], image: '/images/embellishments/prod_1.jpg', isFeatured: true, stock: 30 },
  { title: 'Mirror Work Patch', categorySlug: 'embellishments', price: 260, unit: 'piece', material: ['Mirror'], colors: ['Multicolour'], styles: ['Traditional'], image: '/images/embellishments/prod_3.jpg', isNewArrival: true, stock: 46 },
  { title: 'Pearl Hanging Motif', categorySlug: 'embellishments', price: 350, unit: 'piece', material: ['Beads'], colors: ['Gold'], styles: ['Tassel'], image: '/images/embellishments/prod_9.jpg', isFeatured: true, stock: 16 },
  { title: 'Crystal Stone Patch', categorySlug: 'embellishments', price: 450, unit: 'piece', material: ['Crystal'], colors: ['Gold'], styles: ['Bridal'], image: '/images/embellishments/prod_12.jpg', isNewArrival: true, stock: 12 },
];

async function seedCatalog() {
  await connectDB();

  const categoryMap = {};
  for (const category of categories) {
    const doc = await Category.findOneAndUpdate(
      { slug: category.slug },
      { $set: { ...category, isActive: true } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    categoryMap[category.slug] = doc._id;
  }

  let upserted = 0;
  for (const product of products) {
    const slug = slugify(product.title);
    await Product.findOneAndUpdate(
      { slug },
      {
        $set: {
          title: product.title,
          slug,
          sku: product.sku || slug.toUpperCase().slice(0, 12),
          category: categoryMap[product.categorySlug],
          shortDescription: `Premium ${product.title.toLowerCase()} from PARISUTRA.`,
          description: '<p>Handcrafted trim for ethnic wear, home décor, and boutique collections.</p>',
          images: [{ url: product.image, isMain: true }],
          price: product.price,
          comparePrice: product.comparePrice,
          unit: product.unit,
          stock: product.stock,
          material: product.material,
          colors: product.colors,
          styles: product.styles,
          rating: 4.6,
          reviewCount: 24,
          isFeatured: Boolean(product.isFeatured),
          isNewArrival: Boolean(product.isNewArrival),
          isActive: true,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    upserted += 1;
  }

  const [categoryCount, productCount] = await Promise.all([
    Category.countDocuments({ isActive: true }),
    Product.countDocuments({ isActive: true }),
  ]);
  console.log(`Catalog ready: ${upserted} products upserted. Active categories ${categoryCount}, active products ${productCount}.`);
  process.exit(0);
}

seedCatalog().catch((err) => {
  console.error(err);
  process.exit(1);
});
