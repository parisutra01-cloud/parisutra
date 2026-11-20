import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import AdminIcon from '../../../components/admin/AdminIcons.jsx';
import { api } from '../../../api/client.js';
import { checkImageFile, discardUploadedAsset, getUploadConfig, uploadImage } from '../../../utils/cloudinaryUpload.js';

const SORT_OPTIONS = [
  ['order', 'Display order'],
  ['name-asc', 'Name: A to Z'],
  ['name-desc', 'Name: Z to A'],
  ['products-desc', 'Most products'],
  ['products-asc', 'Fewest products'],
  ['newest', 'Newest first'],
  ['oldest', 'Oldest first'],
  ['updated', 'Recently updated'],
];
const PER_PAGE_OPTIONS = [10, 25, 50];
const DEFAULTS = { q: '', status: 'all', sort: 'order', page: '1', limit: '10', edit: '' };
const EMPTY_FORM = { name: '', slug: '', parent: '', description: '', image: '', sortOrder: '', isActive: true };
const MAX_DESCRIPTION = 1000;
const NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}&' .-]{1,48}$/u;

const card = 'bg-white rounded-2xl border border-[#EFE0E4] shadow-[0_2px_10px_rgba(142,24,56,0.03)]';
const selectClass = 'px-3.5 py-2 rounded-xl border border-[#E8D8DC] bg-white text-[12.5px] text-[#4A3439] focus:outline-none focus:border-[#A91D48] cursor-pointer';
const labelClass = 'block text-[12px] font-semibold text-[#4A3439] mb-1.5';
const inputClass = (error) =>
  `w-full px-3.5 py-2 rounded-xl border ${error ? 'border-[#C92A52]' : 'border-[#E8D8DC]'} bg-[#FDFBFC] text-[12.5px] text-[#2C1E21] focus:outline-none focus:border-[#A91D48]`;

function toSlug(text) {
  return String(text).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fromCategory(c) {
  return {
    name: c.name || '',
    slug: c.slug || '',
    parent: c.parent?._id || c.parent || '',
    description: c.description || '',
    image: c.image || '',
    sortOrder: c.sortOrder ?? '',
    isActive: c.isActive !== false,
  };
}

function validate(form) {
  const e = {};
  const name = form.name.trim().replace(/\s+/g, ' ');
  if (!name) e.name = 'Enter a category name';
  else if (!NAME_PATTERN.test(name) || name.includes('..')) {
    e.name = 'Use 2–49 letters, numbers, spaces, &, apostrophes or hyphens';
  }
  if (form.slug && (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.slug) || form.slug.length > 60)) {
    e.slug = 'Use lowercase letters, numbers and single hyphens (max 60)';
  }
  if (form.description.length > MAX_DESCRIPTION) e.description = `Keep the description under ${MAX_DESCRIPTION} characters`;
  if (form.sortOrder !== '' && !/^\d+$/.test(String(form.sortOrder))) e.sortOrder = 'Enter a whole number (0 or more)';
  return e;
}

function useToast() {
  const [toast, setToast] = useState(null);
  const timer = useRef();
  const show = useCallback((message, type = 'success') => {
    clearTimeout(timer.current);
    setToast({ message, type });
    timer.current = setTimeout(() => setToast(null), 4500);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return [toast, show];
}

function FieldError({ name, errors }) {
  if (!errors[name]) return null;
  return <p data-testid={`error-${name}`} className="mt-1 text-[11px] font-medium text-[#C92A52]">{errors[name]}</p>;
}

function StatCard({ label, value, icon, tone, onClick, active }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`kpi-${label}`}
      className={`${card} p-4 flex items-center gap-3.5 text-left w-full cursor-pointer transition-colors ${active ? 'ring-2 ring-[#A91D48]/40' : 'hover:bg-[#FDF9FA]'}`}
    >
      <span className={`w-12 h-12 rounded-xl flex items-center justify-center shrink-0 ${tone}`}>
        <AdminIcon name={icon} size={22} />
      </span>
      <span>
        <span className="block text-[11.5px] font-medium text-[#7A6268]">{label}</span>
        <span className="block text-[24px] font-bold text-[#2C1E21] leading-none mt-1">{value ?? '—'}</span>
      </span>
    </button>
  );
}

export default function AdminCategoriesPage() {
  const { globalSearch = '' } = useOutletContext() || {};
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, params.get(k) ?? d])), [params]);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [data, setData] = useState({ categories: [], pagination: null, stats: null });
  const [allCategories, setAllCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [toast, showToast] = useToast();

  // Create / edit panel
  const [form, setForm] = useState(EMPTY_FORM);
  const [editing, setEditing] = useState(null); // the saved category being edited
  const [editState, setEditState] = useState('idle'); // idle | loading | missing | error
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [uploadConfig, setUploadConfig] = useState({ enabled: false });
  const [pendingFile, setPendingFile] = useState(null); // create mode: uploaded after the category exists
  const [pendingPreview, setPendingPreview] = useState('');
  const [uploading, setUploading] = useState(false);
  const [imageError, setImageError] = useState('');
  const sessionUploads = useRef(new Map()); // assetId → url, uploaded in this visit but not saved yet
  const nameInput = useRef(null);
  const fileInput = useRef(null);

  // Confirmation dialogs
  const [confirm, setConfirm] = useState(null); // { kind: 'deactivate' | 'delete', category, usage }
  const [busy, setBusy] = useState(false);

  const updateFilters = useCallback((changes, { resetPage = true } = {}) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries({ ...changes, ...(resetPage ? { page: '1' } : {}) })) {
        if (value === undefined || value === '' || value === DEFAULTS[key]) next.delete(key);
        else next.set(key, String(value));
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  useEffect(() => { getUploadConfig().then(setUploadConfig); }, []);

  useEffect(() => {
    if (globalSearch !== '') setSearchInput(globalSearch);
  }, [globalSearch]);

  useEffect(() => {
    const t = setTimeout(() => {
      if (searchInput.trim() !== filters.q) updateFilters({ q: searchInput.trim() });
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, filters.q, updateFilters]);

  // Listing (the edit panel's ?edit= param doesn't trigger a reload)
  const listQuery = useMemo(() => {
    const query = new URLSearchParams();
    for (const key of ['q', 'status', 'sort', 'page', 'limit']) if (filters[key] && filters[key] !== 'all') query.set(key, filters[key]);
    return query.toString();
  }, [filters]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    api(`/categories/manage?${listQuery}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load categories.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [listQuery, reloadKey]);

  // Every category (for the parent picker), refreshed with the list.
  useEffect(() => {
    api('/categories/manage').then((d) => setAllCategories(d.categories || [])).catch(() => {});
  }, [reloadKey]);

  const discardSessionUploads = useCallback((keepUrl) => {
    for (const [assetId, url] of sessionUploads.current) {
      if (url !== keepUrl) discardUploadedAsset(assetId).catch(() => {});
    }
    sessionUploads.current.clear();
  }, []);

  // Uploaded-but-unsaved images are removed when leaving the page.
  useEffect(() => () => discardSessionUploads(), [discardSessionUploads]);

  const resetForm = useCallback(() => {
    setForm(EMPTY_FORM);
    setEditing(null);
    setErrors({});
    setImageError('');
    setSlugTouched(false);
    setPendingFile(null);
    setPendingPreview('');
  }, []);

  // Edit mode lives in the URL (?edit=<id>) so it survives a refresh.
  useEffect(() => {
    if (!filters.edit) {
      setEditState('idle');
      return undefined;
    }
    let cancelled = false;
    setEditState('loading');
    api(`/categories/manage/${filters.edit}`)
      .then((d) => {
        if (cancelled) return;
        setEditing({ ...d.category, usage: d.usage });
        setForm(fromCategory(d.category));
        setErrors({});
        setImageError('');
        setSlugTouched(true);
        setEditState('idle');
      })
      .catch((err) => {
        if (cancelled) return;
        setEditing(null);
        setEditState(err.status === 404 ? 'missing' : 'error');
      });
    return () => { cancelled = true; };
  }, [filters.edit]);

  useEffect(() => {
    if (!pendingFile) return undefined;
    const url = URL.createObjectURL(pendingFile);
    setPendingPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [pendingFile]);

  const startCreate = () => {
    discardSessionUploads();
    resetForm();
    updateFilters({ edit: '' }, { resetPage: false });
    setTimeout(() => {
      nameInput.current?.focus();
      nameInput.current?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }, 0);
  };

  const startEdit = (category) => {
    discardSessionUploads();
    updateFilters({ edit: category._id }, { resetPage: false });
  };

  const cancelEdit = () => {
    discardSessionUploads();
    resetForm();
    updateFilters({ edit: '' }, { resetPage: false });
  };

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => {
      const next = { ...f, [key]: value };
      if (key === 'name' && !slugTouched) next.slug = toSlug(value);
      return next;
    });
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  // A category's images live in its Cloudinary folder, which only active categories can upload to.
  const uploadBlockedReason = !uploadConfig.enabled
    ? 'Image uploads are not configured on this server.'
    : editing
      ? editing.isActive === false ? 'Activate this category (and save) before uploading a new image.' : ''
      : !form.isActive ? 'Images can be added to inactive categories after they are activated.' : '';

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setImageError('');
    const problem = checkImageFile(file, uploadConfig);
    if (problem) {
      setImageError(problem);
      return;
    }
    if (!editing) {
      setPendingFile(file); // uploaded once the category has been created
      return;
    }
    setUploading(true);
    try {
      const asset = await uploadImage(file, editing._id, uploadConfig);
      // Replacing an unsaved upload: the previous one is no longer needed.
      for (const [assetId, url] of sessionUploads.current) {
        if (url !== editing.image) discardUploadedAsset(assetId).catch(() => {});
      }
      sessionUploads.current.clear();
      sessionUploads.current.set(asset._id, asset.secureUrl);
      setForm((f) => ({ ...f, image: asset.secureUrl }));
    } catch (err) {
      setImageError(err.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  };

  const removeImage = () => {
    if (pendingFile) {
      setPendingFile(null);
      setPendingPreview('');
      return;
    }
    for (const [assetId, url] of sessionUploads.current) {
      if (url === form.image) {
        discardUploadedAsset(assetId).catch(() => {});
        sessionUploads.current.delete(assetId);
      }
    }
    setForm((f) => ({ ...f, image: '' }));
  };

  const focusFirstError = (errs) => {
    const first = ['name', 'slug', 'parent', 'description', 'image', 'sortOrder'].find((k) => errs[k]);
    if (first) document.getElementById(`category-${first}`)?.focus();
  };

  const payload = () => ({
    name: form.name.trim().replace(/\s+/g, ' '),
    slug: form.slug || undefined,
    parent: form.parent || null,
    description: form.description.trim(),
    image: form.image,
    ...(form.sortOrder !== '' ? { sortOrder: Number(form.sortOrder) } : {}),
    isActive: form.isActive,
  });

  const save = async (body) => {
    setSaving(true);
    try {
      if (editing) {
        const res = await api(`/categories/${editing._id}`, { method: 'PATCH', body: JSON.stringify(body) });
        sessionUploads.current.clear(); // the uploaded image is now saved on the category
        const slugChanged = res.category.slug !== editing.slug;
        showToast(slugChanged
          ? `“${res.category.name}” saved. Its old address /${editing.slug} still opens the category.`
          : `“${res.category.name}” saved.`);
        resetForm();
        updateFilters({ edit: '' }, { resetPage: false });
      } else {
        const res = await api('/categories', { method: 'POST', body: JSON.stringify(body) });
        let note = '';
        if (pendingFile) {
          try {
            const asset = await uploadImage(pendingFile, res.category._id, uploadConfig);
            try {
              await api(`/categories/${res.category._id}`, { method: 'PATCH', body: JSON.stringify({ image: asset.secureUrl }) });
            } catch (err) {
              discardUploadedAsset(asset._id).catch(() => {});
              throw err;
            }
          } catch (err) {
            note = ` The image could not be uploaded (${err.message || 'upload failed'}); edit the category to try again.`;
          }
        }
        showToast(`Category “${res.category.name}” created.${note}`, note ? 'error' : 'success');
        resetForm();
      }
      setReloadKey((k) => k + 1);
    } catch (err) {
      const fieldErrors = err.errors || {};
      if (Object.keys(fieldErrors).length) {
        setErrors(fieldErrors);
        focusFirstError(fieldErrors);
      }
      showToast(err.message || 'Could not save the category.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const onSubmit = async (e) => {
    e.preventDefault();
    if (saving || uploading) return;
    const errs = validate(form);
    setErrors(errs);
    if (Object.keys(errs).length) {
      focusFirstError(errs);
      return;
    }
    const body = payload();
    // Deactivating from the form: confirm with the number of affected products first.
    if (editing && editing.isActive !== false && body.isActive === false) {
      setConfirm({ kind: 'deactivate', category: editing, usage: editing.usage, body });
      return;
    }
    await save(body);
  };

  const askDeactivate = async (category) => {
    setBusy(true);
    try {
      const d = await api(`/categories/manage/${category._id}`);
      setConfirm({ kind: 'deactivate', category: d.category, usage: d.usage });
    } catch (err) {
      showToast(err.message || 'Could not load the category.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const askDelete = async (category) => {
    setBusy(true);
    try {
      const d = await api(`/categories/manage/${category._id}`);
      setConfirm({ kind: 'delete', category: d.category, usage: d.usage });
    } catch (err) {
      showToast(err.message || 'Could not load the category.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const setActive = async (category, isActive) => {
    setBusy(true);
    try {
      await api(`/categories/${category._id}`, { method: 'PATCH', body: JSON.stringify({ isActive }) });
      showToast(isActive ? `“${category.name}” is active and visible in the store again.` : `“${category.name}” is now hidden from the store.`);
      setConfirm(null);
      if (editing?._id === category._id) {
        discardSessionUploads();
        resetForm();
        updateFilters({ edit: '' }, { resetPage: false });
      }
      setReloadKey((k) => k + 1);
    } catch (err) {
      showToast(err.message || 'Could not update the category.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const confirmAction = async () => {
    if (!confirm) return;
    if (confirm.kind === 'deactivate') {
      if (confirm.body) {
        setConfirm(null);
        await save(confirm.body);
      } else {
        await setActive(confirm.category, false);
      }
      return;
    }
    setBusy(true);
    try {
      await api(`/categories/${confirm.category._id}`, { method: 'DELETE' });
      showToast(`Category “${confirm.category.name}” was deleted.`);
      if (editing?._id === confirm.category._id) cancelEdit();
      setConfirm(null);
      setReloadKey((k) => k + 1);
    } catch (err) {
      if (err.status === 409) {
        // Products were added since the dialog opened: show the latest counts instead.
        const d = await api(`/categories/manage/${confirm.category._id}`).catch(() => null);
        if (d) setConfirm({ kind: 'delete', category: d.category, usage: d.usage });
      }
      showToast(err.message || 'Could not delete the category.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const { categories, pagination, stats } = data;
  const page = pagination?.page || 1;
  const pages = pagination?.pages || 1;
  const total = pagination?.total || 0;
  const limit = pagination?.limit || Number(filters.limit);
  const hasFilters = filters.q !== '' || filters.status !== 'all';
  const parentOptions = allCategories.filter((c) => !c.parent && c._id !== editing?._id);
  const imagePreview = pendingPreview || form.image;
  const canDelete = confirm && !(confirm.usage?.products || confirm.usage?.media || confirm.usage?.children);

  return (
    <div className="space-y-5 pb-12">
      {toast && (
        <div
          data-testid="toast"
          role="status"
          className={`fixed bottom-6 right-6 z-50 max-w-sm px-4 py-3 rounded-xl shadow-lg flex items-start gap-2.5 text-[13px] font-medium text-white ${toast.type === 'error' ? 'bg-[#B4233F]' : 'bg-[#2C1E21]'}`}
        >
          <span className={`w-2 h-2 mt-1.5 rounded-full shrink-0 ${toast.type === 'error' ? 'bg-white' : 'bg-[#249A62]'}`} />
          {toast.message}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <div className="flex items-center gap-1.5 text-[12px] text-[#8C7076] mb-1.5">
            <Link to="/admin/products" className="hover:text-[#A91D48] transition-colors">Products</Link>
            <AdminIcon name="chevron-right" size={12} className="text-[#B89CA3]" />
            <span className="text-[#4A3439] font-medium">Categories</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-[#FDF2F5] border border-[#F3DCE2] flex items-center justify-center text-[#A91D48] shrink-0">
              <AdminIcon name="layers" size={22} />
            </div>
            <div>
              <h1 className="text-[24px] font-bold text-[#8E1838] leading-tight" style={{ fontFamily: "'Playfair Display', Georgia, serif" }}>
                Product Categories
              </h1>
              <p className="text-[12.5px] text-[#7A6268] mt-0.5">
                Organize your products into categories to make them easy to find for your customers.
              </p>
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={startCreate}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#8E1838] text-white text-[12.5px] font-semibold hover:bg-[#77132E] transition-colors shadow-xs cursor-pointer self-start sm:self-auto"
        >
          <AdminIcon name="plus" size={15} />
          Add New Category
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Left: stats + table */}
        <div className="xl:col-span-8 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3.5">
            <StatCard label="Total Categories" value={stats?.total} icon="layers" tone="bg-[#FDEBF1] text-[#B82050]" active={filters.status === 'all'} onClick={() => updateFilters({ status: 'all' })} />
            <StatCard label="Active Categories" value={stats?.active} icon="check-circle" tone="bg-[#E6F7EE] text-[#1D8852]" active={filters.status === 'active'} onClick={() => updateFilters({ status: 'active' })} />
            <StatCard label="Inactive Categories" value={stats?.inactive} icon="eye-off" tone="bg-[#FDE8EC] text-[#C92A52]" active={filters.status === 'inactive'} onClick={() => updateFilters({ status: 'inactive' })} />
            <StatCard label="Products in Categories" value={stats?.products} icon="box" tone="bg-[#F3ECF9] text-[#8244B8]" onClick={() => updateFilters({ sort: 'products-desc' })} />
          </div>

          <div className={`${card} overflow-hidden`}>
            <div className="p-3.5 border-b border-[#F3E6EA] flex flex-wrap items-center gap-2.5">
              <div className="relative flex-1 min-w-[220px]">
                <AdminIcon name="search" size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[#9A8187]" />
                <input
                  type="search"
                  aria-label="Search categories"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="Search by name, slug or description…"
                  className="w-full pl-9 pr-3.5 py-2 rounded-xl border border-[#E8D8DC] bg-[#FDFBFC] text-[12.5px] text-[#2C1E21] placeholder-[#9A8187] focus:outline-none focus:border-[#A91D48]"
                />
              </div>
              <select aria-label="Status" value={filters.status} onChange={(e) => updateFilters({ status: e.target.value })} className={selectClass}>
                <option value="all">All status</option>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
              <select aria-label="Sort" value={filters.sort} onChange={(e) => updateFilters({ sort: e.target.value })} className={selectClass}>
                {SORT_OPTIONS.map(([value, label]) => <option key={value} value={value}>Sort: {label}</option>)}
              </select>
              {hasFilters && (
                <button type="button" onClick={() => { setSearchInput(''); updateFilters({ q: '', status: 'all' }); }} className="text-[12px] font-semibold text-[#A91D48] hover:underline cursor-pointer">
                  Clear filters
                </button>
              )}
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-[#FDF7F8] border-b border-[#F1E2E6] text-[11.5px] font-bold text-[#4A3439]">
                    <th className="py-3 pl-4 pr-3">Category</th>
                    <th className="py-3 px-3">Products</th>
                    <th className="py-3 px-3">Status</th>
                    <th className="py-3 px-3">Order</th>
                    <th className="py-3 px-3">Updated</th>
                    <th className="py-3 pl-3 pr-4 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F5EAEC] text-[12px]">
                  {loading && Array.from({ length: 4 }).map((_, i) => (
                    <tr key={`s${i}`} aria-hidden="true">
                      <td colSpan={6} className="py-3 px-4"><div className="h-9 rounded-lg bg-[#F7EEF1] animate-pulse" /></td>
                    </tr>
                  ))}

                  {!loading && error && (
                    <tr>
                      <td colSpan={6} className="py-10 text-center">
                        <p className="text-[13px] font-semibold text-[#B4233F]">Could not load categories</p>
                        <p className="text-[12px] text-[#7A6268] mt-1">{error}</p>
                        <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="mt-3 px-4 py-2 rounded-xl border border-[#E6D6DA] text-[12px] font-semibold text-[#8E1838] cursor-pointer">
                          Try again
                        </button>
                      </td>
                    </tr>
                  )}

                  {!loading && !error && categories.length === 0 && (
                    <tr>
                      <td colSpan={6} data-testid="empty-state" className="py-12 text-center text-[#7A6268]">
                        {hasFilters ? (
                          <>No categories match these filters.</>
                        ) : (
                          <>No categories yet. <button type="button" onClick={startCreate} className="font-semibold text-[#A91D48] hover:underline cursor-pointer">Add the first one</button>.</>
                        )}
                      </td>
                    </tr>
                  )}

                  {!loading && !error && categories.map((cat) => (
                    <tr key={cat._id} data-testid="category-row" data-id={cat._id} className={`hover:bg-[#FDF9FA] transition-colors ${filters.edit === cat._id ? 'bg-[#FDF5F7]' : ''}`}>
                      <td className="py-3 pl-4 pr-3">
                        <div className="flex items-center gap-3">
                          {cat.image ? (
                            <img src={cat.image} alt="" className="w-10 h-10 rounded-lg object-cover border border-[#EAE0E2] shrink-0" />
                          ) : (
                            <span className="w-10 h-10 rounded-lg border border-dashed border-[#E3CCD2] bg-[#FDFBFC] flex items-center justify-center text-[#C4A9B0] shrink-0">
                              <AdminIcon name="image" size={16} />
                            </span>
                          )}
                          <div className="min-w-0">
                            <button type="button" onClick={() => startEdit(cat)} data-testid="category-name" className="font-bold text-[#2C1E21] hover:text-[#A91D48] text-left cursor-pointer">
                              {cat.name}
                            </button>
                            <p className="text-[11px] text-[#8C7076] truncate">
                              /{cat.slug}{cat.parentName ? ` · in ${cat.parentName}` : ''}{cat.childCount ? ` · ${plural(cat.childCount, 'sub-category', 'sub-categories')}` : ''}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="py-3 px-3" data-testid="category-products">
                        <span className="font-semibold text-[#2C1E21]">{cat.productCount}</span>
                        {cat.productCount !== cat.activeProductCount && (
                          <span className="block text-[10.5px] text-[#8C7076]">{cat.activeProductCount} active</span>
                        )}
                      </td>
                      <td className="py-3 px-3">
                        <span
                          data-testid="category-status"
                          className={`inline-flex px-2 py-0.5 rounded-full text-[11px] font-semibold ${cat.isActive === false ? 'bg-[#F3ECEE] text-[#7A6268]' : 'bg-[#E6F7EE] text-[#1D8852]'}`}
                        >
                          {cat.isActive === false ? 'Inactive' : 'Active'}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-[#4A3439] font-semibold">{cat.sortOrder}</td>
                      <td className="py-3 px-3 text-[#5E474D] text-[11.5px]">{formatDate(cat.updatedAt)}</td>
                      <td className="py-3 pl-3 pr-4">
                        <div className="flex items-center justify-center gap-1.5">
                          <button type="button" onClick={() => startEdit(cat)} title="Edit category" aria-label={`Edit ${cat.name}`} className="w-7 h-7 rounded-lg border border-[#EDE0E3] bg-[#FDF9FA] text-[#A91D48] hover:bg-[#FCE8EE] flex items-center justify-center cursor-pointer">
                            <AdminIcon name="edit" size={13} />
                          </button>
                          {cat.isActive === false ? (
                            <button type="button" disabled={busy} onClick={() => setActive(cat, true)} title="Activate category" aria-label={`Activate ${cat.name}`} data-testid="activate" className="w-7 h-7 rounded-lg border border-[#EDE0E3] bg-[#FDF9FA] text-[#1D8852] hover:bg-[#E6F7EE] flex items-center justify-center cursor-pointer disabled:opacity-50">
                              <AdminIcon name="eye" size={13} />
                            </button>
                          ) : (
                            <button type="button" disabled={busy} onClick={() => askDeactivate(cat)} title="Deactivate category" aria-label={`Deactivate ${cat.name}`} data-testid="deactivate" className="w-7 h-7 rounded-lg border border-[#EDE0E3] bg-[#FDF9FA] text-[#7A6268] hover:bg-[#FCE8EE] flex items-center justify-center cursor-pointer disabled:opacity-50">
                              <AdminIcon name="eye-off" size={13} />
                            </button>
                          )}
                          <button type="button" disabled={busy} onClick={() => askDelete(cat)} title="Delete category" aria-label={`Delete ${cat.name}`} data-testid="delete" className="w-7 h-7 rounded-lg border border-[#EDE0E3] bg-[#FDF9FA] text-[#7A6268] hover:bg-[#FCE8EE] hover:text-[#C92A52] flex items-center justify-center cursor-pointer disabled:opacity-50">
                            <AdminIcon name="trash" size={13} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-4 py-3.5 border-t border-[#F3E6EA] flex flex-col sm:flex-row items-center justify-between gap-3 text-[12px] text-[#6E565C]">
              <span data-testid="pagination-summary">
                {total ? `Showing ${(page - 1) * limit + 1}–${Math.min(page * limit, total)} of ${plural(total, 'category', 'categories')}` : 'No categories'}
              </span>
              <div className="flex items-center gap-1.5">
                <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => updateFilters({ page: page - 1 }, { resetPage: false })} className="w-7 h-7 rounded-lg border border-[#E6D6DA] bg-white flex items-center justify-center text-[#6E565C] hover:bg-[#FDF5F7] cursor-pointer disabled:opacity-40 disabled:cursor-default">
                  <AdminIcon name="chevron-right" size={13} className="rotate-180" />
                </button>
                <span className="px-2 font-semibold text-[#4A3439]">Page {page} of {pages}</span>
                <button type="button" aria-label="Next page" disabled={page >= pages} onClick={() => updateFilters({ page: page + 1 }, { resetPage: false })} className="w-7 h-7 rounded-lg border border-[#E6D6DA] bg-white flex items-center justify-center text-[#6E565C] hover:bg-[#FDF5F7] cursor-pointer disabled:opacity-40 disabled:cursor-default">
                  <AdminIcon name="chevron-right" size={13} />
                </button>
              </div>
              <select aria-label="Per page" value={filters.limit} onChange={(e) => updateFilters({ limit: e.target.value })} className="px-3 py-1.5 rounded-lg border border-[#E6D6DA] bg-white text-[12px] text-[#4A3439] focus:outline-none cursor-pointer">
                {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n} per page</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Right: create / edit form */}
        <div className="xl:col-span-4 space-y-4">
          <div className={`${card} p-5 space-y-4`} data-testid="category-form">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-lg bg-[#FDF0F3] text-[#A91D48] flex items-center justify-center">
                  <AdminIcon name={editing ? 'edit' : 'layers'} size={14} />
                </span>
                <h3 className="text-[14px] font-bold text-[#8E1838]" data-testid="form-title">
                  {editing ? `Edit “${editing.name}”` : 'Add New Category'}
                </h3>
              </div>
              {(editing || filters.edit) && (
                <button type="button" onClick={cancelEdit} className="text-[12px] font-semibold text-[#7A6268] hover:text-[#A91D48] cursor-pointer">Cancel</button>
              )}
            </div>

            {editState === 'loading' && <p className="text-[12px] text-[#7A6268]">Loading category…</p>}
            {editState === 'missing' && (
              <p data-testid="edit-missing" className="text-[12px] text-[#B4233F]">This category no longer exists. <button type="button" onClick={cancelEdit} className="font-semibold underline cursor-pointer">Add a new one</button></p>
            )}
            {editState === 'error' && <p className="text-[12px] text-[#B4233F]">Could not load this category. Refresh to try again.</p>}

            {editState === 'idle' && (
              <form onSubmit={onSubmit} noValidate className="space-y-3.5">
                {editing && (
                  <p data-testid="edit-usage" className="text-[11.5px] text-[#6E565C] bg-[#FDF7F8] border border-[#F3E6EA] rounded-xl px-3 py-2">
                    Used by {plural(editing.usage?.products || 0, 'product')}
                    {editing.usage?.products ? ` (${editing.usage.activeProducts} active)` : ''}. Renaming never changes product assignments.
                  </p>
                )}

                <div>
                  <label className={labelClass} htmlFor="category-name">Category Name <span className="text-[#C92A52]">*</span></label>
                  <input id="category-name" ref={nameInput} type="text" value={form.name} onChange={set('name')} placeholder="e.g. Laces" maxLength={60} className={inputClass(errors.name)} />
                  <FieldError name="name" errors={errors} />
                </div>

                <div>
                  <label className={labelClass} htmlFor="category-slug">URL Slug</label>
                  <div className="flex items-center rounded-xl border border-[#E8D8DC] bg-[#FDFBFC] focus-within:border-[#A91D48]">
                    <span className="pl-3.5 text-[12px] text-[#9A8187]">/category/</span>
                    <input
                      id="category-slug"
                      type="text"
                      value={form.slug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        setForm((f) => ({ ...f, slug: e.target.value.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-') }));
                        if (errors.slug) setErrors((prev) => ({ ...prev, slug: undefined }));
                      }}
                      onBlur={() => setForm((f) => ({ ...f, slug: f.slug.replace(/^-|-$/g, '') }))}
                      placeholder="generated-from-name"
                      className="flex-1 min-w-0 pr-3.5 py-2 bg-transparent text-[12.5px] text-[#2C1E21] focus:outline-none"
                    />
                  </div>
                  {editing && form.slug !== editing.slug && form.slug && (
                    <p className="mt-1 text-[11px] text-[#6E565C]">The old address /{editing.slug} will keep working.</p>
                  )}
                  <FieldError name="slug" errors={errors} />
                </div>

                <div>
                  <label className={labelClass} htmlFor="category-parent">Parent Category</label>
                  <select id="category-parent" value={form.parent} onChange={set('parent')} disabled={Boolean(editing?.usage?.children)} className={`${inputClass(errors.parent)} bg-white cursor-pointer`}>
                    <option value="">None (main category)</option>
                    {parentOptions.map((c) => <option key={c._id} value={c._id}>{c.name}{c.isActive === false ? ' (inactive)' : ''}</option>)}
                  </select>
                  {editing?.usage?.children ? <p className="mt-1 text-[11px] text-[#6E565C]">This category has sub-categories, so it stays a main category.</p> : null}
                  <FieldError name="parent" errors={errors} />
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1.5">
                    <label className="text-[12px] font-semibold text-[#4A3439]" htmlFor="category-description">Description</label>
                    <span className="text-[11px] text-[#8C7076]">{form.description.length}/{MAX_DESCRIPTION}</span>
                  </div>
                  <textarea id="category-description" rows={3} value={form.description} maxLength={MAX_DESCRIPTION} onChange={set('description')} placeholder="Optional, shown on the category page" className={`${inputClass(errors.description)} resize-none leading-relaxed`} />
                  <FieldError name="description" errors={errors} />
                </div>

                <div>
                  <span className={labelClass}>Category Image</span>
                  {imagePreview ? (
                    <div className="flex items-center gap-3">
                      <img src={imagePreview} alt="Category" data-testid="category-image-preview" className="w-20 h-20 rounded-xl object-cover border border-[#EAE0E2]" />
                      <div className="space-y-1.5">
                        {pendingFile && <p className="text-[11px] text-[#6E565C]">Uploaded when you save.</p>}
                        {!uploadBlockedReason && (
                          <button type="button" disabled={uploading || saving} onClick={() => fileInput.current?.click()} className="block text-[12px] font-semibold text-[#A91D48] hover:underline cursor-pointer disabled:opacity-50">
                            {uploading ? 'Uploading…' : 'Replace image'}
                          </button>
                        )}
                        <button type="button" disabled={uploading || saving} onClick={removeImage} data-testid="remove-image" className="block text-[12px] font-semibold text-[#7A6268] hover:text-[#C92A52] cursor-pointer disabled:opacity-50">
                          Remove image
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      disabled={Boolean(uploadBlockedReason) || uploading || saving}
                      onClick={() => fileInput.current?.click()}
                      className="w-full border-2 border-dashed border-[#E3CCD2] rounded-xl p-4 text-center bg-[#FDFBFC] hover:bg-[#FDF5F7] transition-colors cursor-pointer flex flex-col items-center justify-center min-h-[95px] disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <AdminIcon name="cloud-upload" size={20} className="text-[#A91D48] mb-1" />
                      <span className="text-[11.5px] font-bold text-[#8E1838]">{uploading ? 'Uploading…' : 'Upload Category Image'}</span>
                      <span className="text-[10px] text-[#7A6268] mt-0.5 leading-tight">
                        JPG, PNG, WEBP, GIF or AVIF · max {Math.round((uploadConfig.maxBytes || 5 * 1024 * 1024) / 1024 / 1024)} MB
                      </span>
                    </button>
                  )}
                  <input ref={fileInput} type="file" accept="image/*" className="hidden" data-testid="category-image-input" onChange={handleFile} />
                  {uploadBlockedReason && <p className="mt-1 text-[11px] text-[#6E565C]">{uploadBlockedReason}</p>}
                  {imageError && <p data-testid="image-error" className="mt-1 text-[11px] font-medium text-[#C92A52]">{imageError}</p>}
                  <FieldError name="image" errors={errors} />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className={labelClass} htmlFor="category-sortOrder">Display Order</label>
                    <input id="category-sortOrder" type="number" min="0" step="1" value={form.sortOrder} onChange={set('sortOrder')} placeholder={editing ? '' : 'Last'} className={inputClass(errors.sortOrder)} />
                    <FieldError name="sortOrder" errors={errors} />
                  </div>
                  <div>
                    <label className={labelClass} htmlFor="category-status">Status</label>
                    <select id="category-status" value={form.isActive ? 'active' : 'inactive'} onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.value === 'active' }))} className={`${inputClass(false)} bg-white cursor-pointer`}>
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </div>
                </div>

                <button type="submit" disabled={saving || uploading} data-testid="save-category" className="w-full py-2.5 rounded-xl bg-[#8E1838] text-white text-[12.5px] font-semibold hover:bg-[#77132E] transition-colors shadow-xs cursor-pointer disabled:opacity-60">
                  {saving ? 'Saving…' : editing ? 'Save Changes' : 'Save Category'}
                </button>
              </form>
            )}
          </div>

          <div className={`${card} p-4 text-[11.5px] text-[#6E565C] leading-relaxed space-y-2`}>
            <h3 className="text-[13px] font-bold text-[#8E1838]">How categories behave</h3>
            <p><strong className="text-[#2C1E21]">Inactive</strong> categories disappear from the store menu and category pages. Their products are not changed and stay available in search and on their own pages.</p>
            <p><strong className="text-[#2C1E21]">Delete</strong> is only possible when no product, image or sub-category uses the category. Otherwise deactivate it, or move its products first.</p>
            <p>Changing a slug keeps the old address working, so existing links and bookmarks don&apos;t break.</p>
          </div>
        </div>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => busy || setConfirm(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="confirm-title" data-testid="confirm-dialog" className="bg-white rounded-2xl max-w-md w-full p-6 border border-[#EFE0E4] shadow-xl" onClick={(e) => e.stopPropagation()}>
            {confirm.kind === 'deactivate' ? (
              <>
                <h3 id="confirm-title" className="text-[16px] font-bold text-[#8E1838]">Deactivate “{confirm.category.name}”?</h3>
                <div data-testid="confirm-message" className="mt-3 text-[12.5px] text-[#4A3439] leading-relaxed space-y-2">
                  <p>The category page and menu entry will be hidden from the store.</p>
                  {confirm.usage?.products ? (
                    <p>
                      <strong>{plural(confirm.usage.products, 'product')}</strong> ({confirm.usage.activeProducts} active) belong to this category.
                      They will <strong>not</strong> be changed or hidden: they stay assigned to it and remain visible in search and on their own pages.
                      New products can&apos;t be added to an inactive category.
                    </p>
                  ) : <p>No products use this category.</p>}
                  <p>You can activate it again at any time.</p>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" onClick={() => setConfirm(null)} disabled={busy} className="px-4 py-2 rounded-xl border border-[#E6D6DA] text-[12.5px] font-semibold text-[#4A3439] cursor-pointer">Cancel</button>
                  <button type="button" onClick={confirmAction} disabled={busy} data-testid="confirm-action" className="px-4 py-2 rounded-xl bg-[#8E1838] text-white text-[12.5px] font-semibold cursor-pointer disabled:opacity-60">
                    {busy ? 'Deactivating…' : 'Deactivate category'}
                  </button>
                </div>
              </>
            ) : canDelete ? (
              <>
                <h3 id="confirm-title" className="text-[16px] font-bold text-[#8E1838]">Delete “{confirm.category.name}”?</h3>
                <p data-testid="confirm-message" className="mt-3 text-[12.5px] text-[#4A3439] leading-relaxed">
                  No products, images or sub-categories use this category. It will be <strong>permanently deleted</strong> and this can&apos;t be undone.
                  If you might need it again, deactivate it instead.
                </p>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" onClick={() => setConfirm(null)} disabled={busy} className="px-4 py-2 rounded-xl border border-[#E6D6DA] text-[12.5px] font-semibold text-[#4A3439] cursor-pointer">Cancel</button>
                  <button type="button" onClick={confirmAction} disabled={busy} data-testid="confirm-action" className="px-4 py-2 rounded-xl bg-[#B4233F] text-white text-[12.5px] font-semibold cursor-pointer disabled:opacity-60">
                    {busy ? 'Deleting…' : 'Delete permanently'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3 id="confirm-title" className="text-[16px] font-bold text-[#8E1838]">“{confirm.category.name}” can&apos;t be deleted</h3>
                <div data-testid="confirm-message" className="mt-3 text-[12.5px] text-[#4A3439] leading-relaxed space-y-2">
                  <p>It is still in use:</p>
                  <ul className="list-disc pl-5">
                    {confirm.usage.products ? <li>{plural(confirm.usage.products, 'product')} ({confirm.usage.activeProducts} active)</li> : null}
                    {confirm.usage.media ? <li>{plural(confirm.usage.media, 'image')} in its media folder</li> : null}
                    {confirm.usage.children ? <li>{plural(confirm.usage.children, 'sub-category', 'sub-categories')}</li> : null}
                  </ul>
                  <p>Deleting it would leave those without a category. Deactivate it to hide it from the store, or move them to another category first.</p>
                </div>
                <div className="mt-5 flex justify-end gap-2">
                  <button type="button" onClick={() => setConfirm(null)} disabled={busy} className="px-4 py-2 rounded-xl border border-[#E6D6DA] text-[12.5px] font-semibold text-[#4A3439] cursor-pointer">Close</button>
                  {confirm.category.isActive !== false && (
                    <button type="button" onClick={() => setConfirm({ ...confirm, kind: 'deactivate' })} disabled={busy} data-testid="deactivate-instead" className="px-4 py-2 rounded-xl bg-[#8E1838] text-white text-[12.5px] font-semibold cursor-pointer disabled:opacity-60">
                      Deactivate instead
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
