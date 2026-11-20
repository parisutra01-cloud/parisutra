// CMS, contact and wholesale APIs — happy paths verified during the audit (banners, announcements, stats),
// plus behaviour when Cloudinary is not configured (this process has no CLOUDINARY_* env).
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestContext, expectStatus } from '../helpers/harness.js';

const ctx = await createTestContext(import.meta.url);
after(() => ctx.close());

describe('CMS / contact / wholesale APIs', { skip: ctx.skipReason }, () => {
  let fx;
  const admin = (method, path, body) => ctx.request(method, path, { token: fx.tokens.admin, body });
  before(async () => { fx = await ctx.seed(); });

  test('CMS-10 banner create → list → update → delete round trip', async () => {
    const created = await admin('POST', '/cms/banners', { title: 'Festive', imageUrl: '/images/a.jpg', status: 'published' });
    expectStatus(assert, created, 201);
    const id = created.body.item._id;
    const list = await admin('GET', '/cms/banners');
    assert.ok(list.body.items.some((b) => b._id === id));
    const updated = await admin('PUT', `/cms/banners/${id}`, { title: 'Festive 2' });
    expectStatus(assert, updated, 200);
    assert.equal(updated.body.item.title, 'Festive 2');
    expectStatus(assert, await admin('DELETE', `/cms/banners/${id}`), 200);
    assert.equal(await ctx.models.Banner.exists({ _id: id }), null);
  });

  test('CMS-11 public homepage shows only published, already-live hero banners', async () => {
    await admin('POST', '/cms/banners', { title: 'Live', imageUrl: '/a.jpg', status: 'published', placement: 'homepage-hero' });
    await admin('POST', '/cms/banners', { title: 'Draft', imageUrl: '/a.jpg', status: 'draft', placement: 'homepage-hero' });
    await admin('POST', '/cms/banners', {
      title: 'Future', imageUrl: '/a.jpg', status: 'published', placement: 'homepage-hero', publishAt: new Date(Date.now() + 86400000).toISOString(),
    });
    const res = await ctx.request('GET', '/cms/public/homepage');
    expectStatus(assert, res, 200);
    const titles = res.body.heroBanners.map((b) => b.title);
    assert.ok(titles.includes('Live'));
    assert.ok(!titles.includes('Draft'));
    assert.ok(!titles.includes('Future'));
  });

  test('CMS-12 announcement create / update / delete and public visibility window', async () => {
    const made = await admin('POST', '/cms/announcements', { text: 'Free shipping over ₹999', status: 'published' });
    expectStatus(assert, made, 201);
    await admin('POST', '/cms/announcements', { text: 'Expired', status: 'published', endAt: new Date(Date.now() - 1000).toISOString() });
    const pub = await ctx.request('GET', '/cms/public/announcements');
    const texts = pub.body.announcements.map((a) => a.text);
    assert.ok(texts.includes('Free shipping over ₹999'));
    assert.ok(!texts.includes('Expired'));
    expectStatus(assert, await admin('PUT', `/cms/announcements/${made.body.item._id}`, { status: 'draft' }), 200);
    expectStatus(assert, await admin('DELETE', `/cms/announcements/${made.body.item._id}`), 200);
  });

  test('DASH-04 /cms/stats counts content', async () => {
    const res = await admin('GET', '/cms/stats');
    expectStatus(assert, res, 200);
    assert.equal(res.body.banners, await ctx.models.Banner.countDocuments());
  });

  test('CMS-13 contact form stores a message that admins can list', async () => {
    const sent = await ctx.request('POST', '/contact', { body: { name: 'A', email: 'a@x.test', subject: 'Hi', message: 'Hello' } });
    expectStatus(assert, sent, 201);
    expectStatus(assert, await ctx.request('POST', '/contact', { body: { name: 'A' } }), 400);
    const list = await admin('GET', '/contact');
    expectStatus(assert, list, 200);
    assert.equal(list.body.messages[0].subject, 'Hi');
  });

  test('CMS-14 wholesale enquiry: required fields enforced; admin can set a valid status', async () => {
    expectStatus(assert, await ctx.request('POST', '/wholesale/enquiries', { body: { companyName: 'Co' } }), 400);
    const made = await ctx.request('POST', '/wholesale/enquiries', { body: { companyName: 'Co', contactName: 'C', email: 'c@x.test', phone: '1' } });
    expectStatus(assert, made, 201);
    const upd = await admin('PATCH', `/wholesale/enquiries/${made.body.enquiry._id}/status`, { status: 'contacted' });
    expectStatus(assert, upd, 200);
    assert.equal(upd.body.enquiry.status, 'contacted');
  });

  test('CLD-08 with no Cloudinary credentials: config reports disabled and signing returns 503', async () => {
    const cfg = await admin('GET', '/uploads/config');
    expectStatus(assert, cfg, 200);
    assert.deepEqual(cfg.body, { enabled: false });
    expectStatus(assert, await admin('POST', '/uploads/sign', { categoryId: String(fx.laces._id) }), 503);
  });
});
