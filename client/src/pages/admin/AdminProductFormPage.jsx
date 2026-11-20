import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import AdminIcon from '../../components/admin/AdminIcons.jsx';
import { api } from '../../api/client.js';
import { discardUploadedAsset, getUploadConfig, uploadImage } from '../../utils/cloudinaryUpload.js';

const UNITS = ['meter', 'pair', 'piece', 'pack'];
const MAX_IMAGES = 10;
const SKU_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

const EMPTY = {
  title: '', category: '', unit: 'meter', sku: '', shortDescription: '', description: '',
  price: '', comparePrice: '', costPrice: '', stock: '0', lowStockAlert: '10', trackStock: true,
  material: [], colors: [], styles: [], images: [],
  slug: '', metaTitle: '', metaDescription: '', isActive: true, isFeatured: false, isNewArrival: false,
};

const toSlug = (s) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 200);
// While typing, keep a trailing hyphen so "foo-bar" can be typed; it is trimmed on blur and on save.
const slugWhileTyping = (s) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-/, '').slice(0, 200);
const numText = (v) => (v === undefined || v === null ? '' : String(v));

function fromProduct(p) {
  return {
    ...EMPTY,
    title: p.title || '',
    category: p.category?._id || p.category || '',
    unit: p.unit || 'meter',
    sku: p.sku || '',
    shortDescription: p.shortDescription || '',
    description: p.description || '',
    price: numText(p.price),
    comparePrice: numText(p.comparePrice),
    costPrice: numText(p.costPrice),
    stock: numText(p.stock ?? 0),
    lowStockAlert: numText(p.lowStockAlert ?? 10),
    trackStock: p.trackStock !== false,
    material: p.material || [],
    colors: p.colors || [],
    styles: p.styles || [],
    images: (p.images || []).map((i) => ({ url: i.url, isMain: Boolean(i.isMain) })),
    slug: p.slug || '',
    metaTitle: p.metaTitle || '',
    metaDescription: p.metaDescription || '',
    isActive: p.isActive !== false,
    isFeatured: Boolean(p.isFeatured),
    isNewArrival: Boolean(p.isNewArrival),
  };
}

/** Mirrors the server rules so most mistakes are caught before a round trip. */
function validate(form) {
  const e = {};
  const title = form.title.trim();
  if (!title) e.title = 'Title is required';
  else if (title.length < 2 || title.length > 200) e.title = 'Title must be 2–200 characters';
  if (!form.category) e.category = 'Choose a category';
  const price = Number(form.price);
  if (form.price === '') e.price = 'Selling price is required';
  else if (!Number.isFinite(price) || price <= 0) e.price = 'Selling price must be greater than 0';
  if (form.comparePrice !== '') {
    const cp = Number(form.comparePrice);
    if (!Number.isFinite(cp) || cp < 0) e.comparePrice = 'Compare price cannot be negative';
    else if (cp > 0 && Number.isFinite(price) && cp < price) e.comparePrice = 'Compare price must be at least the selling price';
  }
  if (form.costPrice !== '' && (!Number.isFinite(Number(form.costPrice)) || Number(form.costPrice) < 0)) e.costPrice = 'Cost price cannot be negative';
  for (const [key, label] of [['stock', 'Stock'], ['lowStockAlert', 'Low stock alert']]) {
    const n = Number(form[key]);
    if (form[key] === '') e[key] = `${label} is required`;
    else if (!Number.isInteger(n) || n < 0) e[key] = `${label} must be a whole number of 0 or more`;
  }
  if (form.sku.trim() && !SKU_PATTERN.test(form.sku.trim())) e.sku = 'Use letters, numbers, ".", "_", "/" or "-" (max 64)';
  return e;
}

function toPayload(form, { isActive, isEdit }) {
  const payload = {
    title: form.title.trim(),
    category: form.category,
    unit: form.unit,
    sku: form.sku.trim(),
    shortDescription: form.shortDescription,
    description: form.description,
    price: Number(form.price),
    comparePrice: form.comparePrice === '' ? '' : Number(form.comparePrice),
    costPrice: form.costPrice === '' ? '' : Number(form.costPrice),
    stock: Number(form.stock),
    lowStockAlert: Number(form.lowStockAlert),
    trackStock: form.trackStock,
    material: form.material,
    colors: form.colors,
    styles: form.styles,
    images: form.images.map(({ url, isMain }) => ({ url, isMain })),
    metaTitle: form.metaTitle,
    metaDescription: form.metaDescription,
    isActive,
    isFeatured: form.isFeatured,
    isNewArrival: form.isNewArrival,
  };
  const slug = toSlug(form.slug);
  if (slug || isEdit) payload.slug = slug;
  return payload;
}

const inputClass = (hasError) =>
  `w-full px-3.5 py-2 rounded-xl border bg-[#FDFBFC] text-[12.5px] text-[#2C1E21] focus:outline-none ${hasError ? 'border-[#C92A52] focus:border-[#C92A52]' : 'border-[#E8D8DC] focus:border-[#A91D48]'}`;
const labelClass = 'block text-[12px] font-semibold text-[#4A3439] mb-1.5';

function FieldError({ name, errors }) {
  if (!errors[name]) return null;
  return <p id={`${name}-error`} data-testid={`error-${name}`} className="mt-1 text-[11px] font-medium text-[#C92A52]">{errors[name]}</p>;
}

function Card({ step, title, children, action }) {
  return (
    <section className="bg-white rounded-2xl border border-[#EFE0E4] p-5 shadow-[0_2px_12px_rgba(142,24,56,0.03)] space-y-4">
      <div className="flex items-center justify-between gap-3 border-b border-[#F5EAEC] pb-3.5">
        <div className="flex items-center gap-2.5">
          <span className="w-6 h-6 rounded-full bg-[#8E1838] text-white text-[12px] font-bold flex items-center justify-center">{step}</span>
          <h2 className="text-[15px] font-bold text-[#8E1838]">{title}</h2>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function Toggle({ label, hint, checked, onChange, name }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div>
        <p className="text-[12.5px] font-bold text-[#2C1E21]">{label}</p>
        {hint && <p className="text-[11px] text-[#7A6268]">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        name={name}
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors ${checked ? 'bg-[#8E1838]' : 'bg-[#D6C2C6]'}`}
      >
        <span className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow transition ${checked ? 'translate-x-5' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

function TagInput({ label, name, values, onChange, placeholder, errors }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v && !values.some((x) => x.toLowerCase() === v.toLowerCase()) && values.length < 20 && v.length <= 50) onChange([...values, v]);
    setDraft('');
  };
  return (
    <div>
      <label className={labelClass} htmlFor={`${name}-input`}>{label}</label>
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-[#E8D8DC] bg-[#FDFBFC] px-2 py-1.5">
        {values.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-[#FDEBF1] text-[11.5px] font-medium text-[#A91D48]">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))} className="text-[#A91D48] hover:text-[#C92A52] cursor-pointer">×</button>
          </span>
        ))}
        <input
          id={`${name}-input`}
          name={name}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); } }}
          onBlur={add}
          placeholder={values.length ? '' : placeholder}
          className="flex-1 min-w-[90px] bg-transparent px-1 py-0.5 text-[12px] focus:outline-none"
        />
      </div>
      <FieldError name={name} errors={errors} />
    </div>
  );
}

export default function AdminProductFormPage() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();

  const [form, setForm] = useState(EMPTY);
  const [original, setOriginal] = useState(null);
  const [categories, setCategories] = useState([]);
  const [loadState, setLoadState] = useState(isEdit ? 'loading' : 'ready');
  const [loadError, setLoadError] = useState('');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [slugTouched, setSlugTouched] = useState(isEdit);
  const [uploadConfig, setUploadConfig] = useState({ enabled: false });
  const [uploading, setUploading] = useState(null);
  const [imageError, setImageError] = useState('');
  const sessionUploads = useRef(new Map());
  const fileInput = useRef(null);
  const toastTimer = useRef();

  const showToast = useCallback((message, type = 'success') => {
    clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = setTimeout(() => setToast(null), 5000);
  }, []);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // Images uploaded in this visit but never saved are removed from Cloudinary when leaving the page.
  useEffect(() => () => {
    for (const assetId of sessionUploads.current.keys()) discardUploadedAsset(assetId).catch(() => {});
    sessionUploads.current.clear();
  }, []);

  useEffect(() => {
    getUploadConfig().then(setUploadConfig);
    api('/categories/manage').then((d) => setCategories(d.categories || [])).catch(() => setCategories([]));
  }, []);

  const loadProduct = useCallback(() => {
    if (!isEdit) return;
    setLoadState('loading');
    setLoadError('');
    api(`/products/manage/${id}`)
      .then((d) => {
        setForm(fromProduct(d.product));
        setOriginal(d.product);
        setLoadState('ready');
      })
      .catch((err) => {
        setLoadState(err.status === 404 || err.status === 400 ? 'notfound' : 'error');
        setLoadError(err.message || 'Could not load the product.');
      });
  }, [id, isEdit]);

  useEffect(() => { loadProduct(); }, [loadProduct]);

  const set = (key) => (value) => {
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === 'title' && !slugTouched) next.slug = toSlug(value);
      return next;
    });
    if (errors[key]) setErrors(({ [key]: _, ...rest }) => rest);
  };
  const bind = (key) => ({
    name: key,
    id: key,
    value: form[key],
    onChange: (e) => set(key)(e.target.value),
    'aria-invalid': Boolean(errors[key]) || undefined,
    'aria-describedby': errors[key] ? `${key}-error` : undefined,
  });

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setImageError('');
    if (!form.category) {
      setImageError('Choose the product category first: images are stored in the category folder.');
      return;
    }
    const room = MAX_IMAGES - form.images.length;
    if (room <= 0) {
      setImageError(`A product can have at most ${MAX_IMAGES} images.`);
      return;
    }
    const queue = files.slice(0, room);
    const problems = files.length > room ? [`Only ${room} more image${room === 1 ? '' : 's'} can be added.`] : [];
    for (let i = 0; i < queue.length; i += 1) {
      setUploading({ current: i + 1, total: queue.length });
      try {
        const asset = await uploadImage(queue[i], form.category, uploadConfig);
        sessionUploads.current.set(asset._id, asset.secureUrl);
        setForm((f) => ({
          ...f,
          images: f.images.some((img) => img.url === asset.secureUrl)
            ? f.images
            : [...f.images, { url: asset.secureUrl, isMain: f.images.length === 0, assetId: asset._id }],
        }));
      } catch (err) {
        problems.push(err.message || `Upload of "${queue[i].name}" failed.`);
      }
    }
    setUploading(null);
    if (problems.length) setImageError(problems.join(' '));
  };

  const removeImage = (url) => {
    const img = form.images.find((i) => i.url === url);
    setForm((f) => {
      const rest = f.images.filter((i) => i.url !== url);
      if (rest.length && !rest.some((i) => i.isMain)) rest[0] = { ...rest[0], isMain: true };
      return { ...f, images: rest };
    });
    // Never-saved uploads are deleted right away; images already saved on the product stay in the media library.
    if (img?.assetId && sessionUploads.current.has(img.assetId)) {
      sessionUploads.current.delete(img.assetId);
      discardUploadedAsset(img.assetId).catch(() => {});
    }
  };

  const makeMain = (url) => setForm((f) => ({ ...f, images: f.images.map((i) => ({ ...i, isMain: i.url === url })) }));

  const save = async (isActive) => {
    if (saving || uploading) return;
    const clientErrors = validate(form);
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length) {
      showToast('Please fix the highlighted fields.', 'error');
      document.querySelector(`[name="${Object.keys(clientErrors)[0]}"]`)?.focus();
      return;
    }
    setSaving(true);
    try {
      const payload = toPayload(form, { isActive, isEdit });
      const { product } = await api(isEdit ? `/products/${id}` : '/products', {
        method: isEdit ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      sessionUploads.current.clear();
      const verb = isEdit ? 'updated' : isActive ? 'published' : 'saved as a draft';
      navigate('/admin/products', { state: { flash: `Product “${product.title}” ${verb}.` } });
    } catch (err) {
      if (err.errors) {
        setErrors(err.errors);
        document.querySelector(`[name="${Object.keys(err.errors)[0]}"]`)?.focus();
      }
      showToast(err.message || 'Could not save the product.', 'error');
      setSaving(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    save(isEdit ? form.isActive : true);
  };

  const cancel = () => navigate('/admin/products');

  if (loadState === 'loading') {
    return (
      <div className="space-y-4" aria-busy="true">
        <div className="h-10 w-64 rounded-xl bg-[#F7EEF0] animate-pulse" />
        <div className="h-64 rounded-2xl bg-[#F7EEF0] animate-pulse" />
        <p className="text-[12.5px] text-[#7A6268]">Loading product…</p>
      </div>
    );
  }
  if (loadState === 'notfound' || loadState === 'error') {
    return (
      <div className="rounded-2xl border border-[#EFE0E4] bg-white p-8 text-center">
        <h1 className="text-[18px] font-bold text-[#8E1838]">{loadState === 'notfound' ? 'Product not found' : 'Could not load this product'}</h1>
        <p className="mt-2 text-[12.5px] text-[#7A6268]" role="alert">{loadError}</p>
        <div className="mt-5 flex justify-center gap-2">
          {loadState === 'error' && <button type="button" onClick={loadProduct} className="px-4 py-2 rounded-xl border border-[#E6D3D8] text-[#8E1838] text-[12.5px] font-semibold cursor-pointer">Try again</button>}
          <Link to="/admin/products" className="px-4 py-2 rounded-xl bg-[#8E1838] text-white text-[12.5px] font-semibold">Back to products</Link>
        </div>
      </div>
    );
  }

  const selectedCategory = categories.find((c) => c._id === form.category);
  const uploadDisabled = !uploadConfig.enabled || Boolean(uploading) || form.images.length >= MAX_IMAGES;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5 pb-12" data-testid="product-form">
      {toast && (
        <div role="status" aria-live="polite" data-testid="toast" className={`fixed bottom-6 right-6 z-50 max-w-sm px-4 py-3 rounded-xl shadow-lg flex items-center gap-2.5 text-[13px] font-medium text-white ${toast.type === 'error' ? 'bg-[#9B1C3A]' : 'bg-[#2C1E21]'}`}>
          <span className={`w-2 h-2 rounded-full shrink-0 ${toast.type === 'error' ? 'bg-[#FFB4C2]' : 'bg-[#249A62]'}`} />
          {toast.message}
        </div>
      )}

      {/* Header & breadcrumb */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[12px] text-[#8C7076] mb-1.5">
            <Link to="/admin/products" className="hover:text-[#A91D48]">Products</Link>
            <AdminIcon name="chevron-right" size={12} className="text-[#B89CA3]" />
            <span className="text-[#4A3439] font-medium">{isEdit ? 'Edit Product' : 'Add New Product'}</span>
          </div>
          <h1 className="text-[24px] font-bold text-[#8E1838] leading-tight" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
            {isEdit ? 'Edit Product' : 'Add New Product'}
          </h1>
          <p className="text-[12.5px] text-[#7A6268] mt-0.5">
            {isEdit ? `Last updated ${new Date(original?.updatedAt).toLocaleString('en-IN')}` : 'Fill in the details below to list a new product in your store.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <button type="button" onClick={cancel} disabled={saving} className="px-4 py-2.5 rounded-xl bg-white border border-[#E6D3D8] text-[#4A3439] text-[12.5px] font-semibold hover:bg-[#FDF5F7] cursor-pointer">
            Cancel
          </button>
          {isEdit && original?.isActive !== false && (
            <a href={`/product/${original.slug}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-[#E6D3D8] text-[#8E1838] text-[12.5px] font-semibold hover:bg-[#FDF5F7]">
              <AdminIcon name="eye" size={15} className="text-[#A91D48]" />
              View in store
            </a>
          )}
          {isEdit ? (
            <button type="submit" disabled={saving || Boolean(uploading)} data-testid="save-product" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#8E1838] text-white text-[12.5px] font-semibold hover:bg-[#77132E] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
              <AdminIcon name="paperplane" size={15} />
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          ) : (
            <>
              <button type="button" onClick={() => save(false)} disabled={saving || Boolean(uploading)} data-testid="save-draft" className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-white border border-[#E6D3D8] text-[#8E1838] text-[12.5px] font-semibold hover:bg-[#FDF5F7] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
                <AdminIcon name="draft" size={15} className="text-[#A91D48]" />
                Save as Draft
              </button>
              <button type="submit" disabled={saving || Boolean(uploading)} data-testid="save-product" className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#8E1838] text-white text-[12.5px] font-semibold hover:bg-[#77132E] cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed">
                <AdminIcon name="paperplane" size={15} />
                {saving ? 'Saving…' : 'Save & Publish'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        <div className="lg:col-span-7 space-y-5">
          <Card step={1} title="Basic Information">
            <div>
              <label className={labelClass} htmlFor="title">Product Title <span className="text-[#C92A52]">*</span></label>
              <input type="text" maxLength={200} placeholder="e.g. Golden Zari Lace Trim" className={inputClass(errors.title)} {...bind('title')} />
              <FieldError name="title" errors={errors} />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
              <div>
                <label className={labelClass} htmlFor="category">Category <span className="text-[#C92A52]">*</span></label>
                <select className={`${inputClass(errors.category)} cursor-pointer bg-white`} {...bind('category')}>
                  <option value="">Choose a category…</option>
                  {/* New assignments need an active category; a product's saved inactive category stays selectable. */}
                  {categories
                    .filter((c) => c.isActive !== false || c._id === (original?.category?._id || original?.category))
                    .map((c) => <option key={c._id} value={c._id}>{c.name}{c.isActive === false ? ' (inactive)' : ''}</option>)}
                </select>
                <FieldError name="category" errors={errors} />
              </div>
              <div>
                <label className={labelClass} htmlFor="unit">Selling Unit <span className="text-[#C92A52]">*</span></label>
                <select className={`${inputClass(errors.unit)} cursor-pointer bg-white capitalize`} {...bind('unit')}>
                  {UNITS.map((u) => <option key={u} value={u}>Per {u}</option>)}
                </select>
                <FieldError name="unit" errors={errors} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[12px] font-semibold text-[#4A3439]" htmlFor="shortDescription">Short Description</label>
                <span className="text-[11px] text-[#8C7076]">{form.shortDescription.length}/500</span>
              </div>
              <textarea rows={3} maxLength={500} placeholder="Brief summary shown on product cards…" className={`${inputClass(errors.shortDescription)} resize-none leading-relaxed`} {...bind('shortDescription')} />
              <FieldError name="shortDescription" errors={errors} />
            </div>
            <div>
              <label className={labelClass} htmlFor="sku">SKU / Product Code</label>
              <input type="text" maxLength={64} placeholder="e.g. GT-1023" className={`${inputClass(errors.sku)} font-mono`} {...bind('sku')} />
              <p className="mt-1 text-[10.5px] text-[#8C7076]">Must be unique across all products.</p>
              <FieldError name="sku" errors={errors} />
            </div>
          </Card>

          <Card
            step={2}
            title="Product Images"
            action={
              <button type="button" onClick={() => fileInput.current?.click()} disabled={uploadDisabled} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#E6D3D8] bg-[#FDF7F8] text-[#8E1838] text-[11.5px] font-semibold hover:bg-[#FCE8EE] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                <AdminIcon name="upload" size={13} className="text-[#A91D48]" />
                Upload images
              </button>
            }
          >
            <input
              ref={fileInput}
              type="file"
              name="images"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              multiple
              hidden
              data-testid="image-input"
              onChange={(e) => { const files = e.target.files; handleFiles(files).finally(() => { e.target.value = ''; }); }}
            />
            {!uploadConfig.enabled && (
              <p className="text-[11.5px] text-[#7A6268]">Image upload is not configured on the server (Cloudinary). Existing images can still be reordered or removed.</p>
            )}
            {uploadConfig.enabled && !form.category && (
              <p className="text-[11.5px] text-[#7A6268]">Choose a category first: images are stored in that category&apos;s folder.</p>
            )}
            {uploading && <p className="text-[11.5px] font-medium text-[#8E1838]" role="status">Uploading image {uploading.current} of {uploading.total}…</p>}
            {(imageError || errors.images) && <p className="text-[11.5px] font-medium text-[#C92A52]" role="alert" data-testid="error-images">{imageError || errors.images}</p>}

            <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-3" data-testid="image-grid">
              {form.images.map((img, index) => (
                <div key={img.url} className="relative rounded-xl overflow-hidden border border-[#E9D8DC] aspect-square bg-[#FBF7F8]" data-testid="image-tile">
                  <img src={img.url} alt={`Product image ${index + 1}`} className="w-full h-full object-cover" />
                  {img.isMain ? (
                    <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-[#8E1838] text-white text-[9.5px] font-bold">Main</span>
                  ) : (
                    <button type="button" onClick={() => makeMain(img.url)} className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-white/90 text-[#8E1838] text-[9.5px] font-bold cursor-pointer">Make main</button>
                  )}
                  <button type="button" aria-label={`Remove image ${index + 1}`} onClick={() => removeImage(img.url)} className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-white/90 text-[#C92A52] hover:bg-[#C92A52] hover:text-white flex items-center justify-center text-[11px] font-bold cursor-pointer">
                    ×
                  </button>
                </div>
              ))}
              {form.images.length < MAX_IMAGES && (
                <button
                  type="button"
                  onClick={() => fileInput.current?.click()}
                  disabled={uploadDisabled}
                  className="border-2 border-dashed border-[#E5CCD2] rounded-xl aspect-square flex flex-col items-center justify-center text-[#8E1838] hover:bg-[#FDF5F7] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <AdminIcon name="plus" size={16} />
                  <span className="text-[10.5px] font-bold mt-1 text-center px-1">{form.images.length ? 'Add more' : 'Upload main image'}</span>
                </button>
              )}
            </div>
            <p className="text-[10.5px] text-[#8C7076]">JPG, PNG, WEBP, GIF or AVIF · up to 5 MB each · max {MAX_IMAGES} images.</p>
          </Card>

          <Card step={3} title="Product Details">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[12px] font-semibold text-[#4A3439]" htmlFor="description">Full Description</label>
                <span className="text-[11px] text-[#8C7076]">{form.description.length}/20000</span>
              </div>
              <textarea rows={8} maxLength={20000} placeholder="Material, dimensions, care instructions, what’s included…" className={`${inputClass(errors.description)} leading-relaxed`} {...bind('description')} />
              <FieldError name="description" errors={errors} />
            </div>
          </Card>
        </div>

        <div className="lg:col-span-5 space-y-5">
          <Card step={4} title="Pricing & Inventory">
            <div className="grid grid-cols-2 gap-3.5">
              {[
                ['price', 'Selling Price', true],
                ['comparePrice', 'Compare Price (MRP)', false],
                ['costPrice', 'Cost Price (private)', false],
              ].map(([key, label, required]) => (
                <div key={key}>
                  <label className={labelClass} htmlFor={key}>{label} {required && <span className="text-[#C92A52]">*</span>}</label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#7A6268] text-[12.5px] font-semibold">₹</span>
                    <input type="number" inputMode="decimal" min="0" step="0.01" className={`${inputClass(errors[key])} pl-7 font-semibold`} {...bind(key)} />
                  </div>
                  <FieldError name={key} errors={errors} />
                </div>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3.5">
              <div>
                <label className={labelClass} htmlFor="stock">Stock Quantity <span className="text-[#C92A52]">*</span></label>
                <input type="number" inputMode="numeric" min="0" step="1" className={`${inputClass(errors.stock)} font-semibold`} {...bind('stock')} />
                <FieldError name="stock" errors={errors} />
              </div>
              <div>
                <label className={labelClass} htmlFor="lowStockAlert">Low Stock Alert</label>
                <input type="number" inputMode="numeric" min="0" step="1" className={`${inputClass(errors.lowStockAlert)} font-semibold`} {...bind('lowStockAlert')} />
                <FieldError name="lowStockAlert" errors={errors} />
              </div>
            </div>
            <Toggle label="Track Stock" hint="Prevent orders when stock runs out" name="trackStock" checked={form.trackStock} onChange={set('trackStock')} />
          </Card>

          <Card step={5} title="Attributes (store filters)">
            <TagInput label="Material" name="material" values={form.material} onChange={set('material')} placeholder="e.g. Zari, Velvet — press Enter" errors={errors} />
            <TagInput label="Colours" name="colors" values={form.colors} onChange={set('colors')} placeholder="e.g. Gold, Maroon — press Enter" errors={errors} />
            <TagInput label="Styles" name="styles" values={form.styles} onChange={set('styles')} placeholder="e.g. Bridal, Traditional — press Enter" errors={errors} />
          </Card>

          <Card step={6} title="SEO & Visibility">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[12px] font-semibold text-[#4A3439]" htmlFor="metaTitle">Meta Title</label>
                <span className="text-[11px] text-[#8C7076]">{form.metaTitle.length}/60</span>
              </div>
              <input type="text" maxLength={120} className={inputClass(errors.metaTitle)} {...bind('metaTitle')} />
              <FieldError name="metaTitle" errors={errors} />
            </div>
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[12px] font-semibold text-[#4A3439]" htmlFor="metaDescription">Meta Description</label>
                <span className="text-[11px] text-[#8C7076]">{form.metaDescription.length}/160</span>
              </div>
              <textarea rows={2} maxLength={320} className={`${inputClass(errors.metaDescription)} resize-none`} {...bind('metaDescription')} />
              <FieldError name="metaDescription" errors={errors} />
            </div>
            <div>
              <label className={labelClass} htmlFor="slug">URL Slug</label>
              <input
                type="text"
                maxLength={200}
                placeholder="generated from the title"
                className={inputClass(errors.slug)}
                {...bind('slug')}
                onChange={(e) => { setSlugTouched(true); set('slug')(slugWhileTyping(e.target.value)); }}
                onBlur={() => set('slug')(toSlug(form.slug))}
              />
              <p className="text-[10px] text-[#8C7076] mt-1 truncate">https://parisutra.in/product/{form.slug || '…'}</p>
              <FieldError name="slug" errors={errors} />
            </div>
            {isEdit && (
              <div>
                <label className={labelClass} htmlFor="status">Product Status</label>
                <select
                  id="status"
                  name="isActive"
                  value={form.isActive ? 'active' : 'inactive'}
                  onChange={(e) => set('isActive')(e.target.value === 'active')}
                  className={`${inputClass(false)} bg-white cursor-pointer`}
                >
                  <option value="active">Active (visible in store)</option>
                  <option value="inactive">Inactive (hidden from store)</option>
                </select>
              </div>
            )}
            <div className="space-y-3 pt-1">
              <Toggle label="Featured product" hint="Shown in the homepage featured row" name="isFeatured" checked={form.isFeatured} onChange={set('isFeatured')} />
              <Toggle label="Include in New Arrivals" name="isNewArrival" checked={form.isNewArrival} onChange={set('isNewArrival')} />
            </div>
            {selectedCategory?.isActive === false && (
              <p className="text-[11px] text-[#B4233F]">Note: the selected category is inactive, so this product won&apos;t appear on its category page.</p>
            )}
          </Card>
        </div>
      </div>
    </form>
  );
}
