import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../../api/client.js';

const empty = { text: '', sortOrder: 0, status: 'published' };

export default function AdminAnnouncementsPage() {
  const [items, setItems] = useState([]);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');

  const load = () => api('/cms/announcements').then((data) => setItems(data.items || []));

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  const save = async (event) => {
    event.preventDefault();
    setError('');
    const payload = { ...form, sortOrder: Number(form.sortOrder) || 0, placement: 'top-bar' };
    try {
      if (form._id) {
        await api(`/cms/announcements/${form._id}`, { method: 'PUT', body: JSON.stringify(payload) });
      } else {
        await api('/cms/announcements', { method: 'POST', body: JSON.stringify(payload) });
      }
      setForm(null);
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const remove = async (id) => {
    if (!confirm('Delete this banner line?')) return;
    setError('');
    try {
      await api(`/cms/announcements/${id}`, { method: 'DELETE' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div>
      <Link to="/admin/content" className="text-sm text-maroon">← Content</Link>
      <div className="mt-2 flex items-center justify-between gap-4">
        <div>
          <h2 className="font-serif text-2xl text-maroon">Top banner</h2>
          <p className="mt-1 text-sm text-neutral-500">The maroon strip above the logo. Published lines show on the storefront.</p>
        </div>
        <button type="button" className="btn-primary text-xs" onClick={() => setForm({ ...empty })}>Add line</button>
      </div>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}

      {form && (
        <form onSubmit={save} className="mt-6 max-w-xl rounded-xl border border-neutral-200 bg-white p-5">
          <h3 className="font-serif text-lg text-maroon">{form._id ? 'Edit line' : 'New line'}</h3>
          <label className="mt-4 block text-sm">
            Text
            <input
              className="input-field mt-1"
              required
              value={form.text}
              onChange={(e) => setForm({ ...form, text: e.target.value })}
              placeholder="Free shipping on orders above ₹999"
            />
          </label>
          <label className="mt-4 block text-sm">
            Sort order
            <input
              className="input-field mt-1"
              type="number"
              value={form.sortOrder}
              onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
            />
          </label>
          <label className="mt-4 block text-sm">
            Status
            <select className="input-field mt-1" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="published">Published</option>
              <option value="draft">Draft</option>
            </select>
          </label>
          <div className="mt-5 flex gap-3">
            <button type="submit" className="btn-primary text-xs">Save</button>
            <button type="button" className="text-sm text-neutral-500" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      <table className="mt-8 w-full text-left text-sm">
        <thead className="border-b text-xs uppercase text-neutral-500">
          <tr>
            <th className="p-2">Order</th>
            <th>Text</th>
            <th>Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item._id} className="border-b">
              <td className="p-2">{item.sortOrder}</td>
              <td>{item.text}</td>
              <td className="capitalize">{item.status}</td>
              <td className="p-2 text-right">
                <button type="button" className="mr-3 text-maroon" onClick={() => setForm(item)}>Edit</button>
                <button type="button" className="text-red-600" onClick={() => remove(item._id)}>Delete</button>
              </td>
            </tr>
          ))}
          {!items.length && (
            <tr>
              <td colSpan={4} className="p-6 text-center text-neutral-500">No banner lines yet. The storefront shows the default three lines until you publish one.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
