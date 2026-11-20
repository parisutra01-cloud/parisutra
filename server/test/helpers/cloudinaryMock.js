/**
 * Minimal local stand-in for the Cloudinary REST API, so upload registration, validation and deletion
 * can be tested without any network access. The API under test is pointed at it through
 * CLOUDINARY_URL=...?upload_prefix=http://127.0.0.1:<port> (a documented Cloudinary SDK option).
 *
 * Supported: GET  /v1_1/:cloud/resources/image/upload/:public_id   (cloudinary.api.resource)
 *            POST /v1_1/:cloud/image/destroy                        (cloudinary.uploader.destroy)
 */
import http from 'node:http';
import { FAKE_CLOUDINARY, freePort } from './harness.js';

export async function startCloudinaryMock() {
  const resources = new Map();
  const calls = [];
  const port = await freePort();
  const cloud = FAKE_CLOUDINARY.CLOUDINARY_CLOUD_NAME;

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      const send = (status, json) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(json));
      };
      const resourcePrefix = `/v1_1/${cloud}/resources/image/upload/`;
      if (req.method === 'GET' && url.pathname.startsWith(resourcePrefix)) {
        const publicId = decodeURIComponent(url.pathname.slice(resourcePrefix.length));
        calls.push({ type: 'resource', publicId });
        const r = resources.get(publicId);
        return r ? send(200, r) : send(404, { error: { message: `Resource not found - ${publicId}` } });
      }
      if (req.method === 'POST' && url.pathname === `/v1_1/${cloud}/image/destroy`) {
        const match = body.match(/name="public_id"\r\n\r\n([^\r\n]+)/) || body.match(/(?:^|&)public_id=([^&]+)/);
        const publicId = match ? decodeURIComponent(match[1]) : null;
        calls.push({ type: 'destroy', publicId });
        resources.delete(publicId);
        return send(200, { result: 'ok' });
      }
      calls.push({ type: 'unexpected', method: req.method, path: url.pathname });
      return send(404, { error: { message: 'Not mocked' } });
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));

  return {
    port,
    calls,
    /** Registers a resource as if the browser had uploaded it directly to Cloudinary. */
    addResource(publicId, { format = 'png', bytes = 2048, tags = [] } = {}) {
      const resource = {
        public_id: publicId,
        format,
        bytes,
        tags,
        resource_type: 'image',
        secure_url: `https://res.cloudinary.com/${cloud}/image/upload/v1/${publicId}.${format}`,
      };
      resources.set(publicId, resource);
      return resource;
    },
    destroyed: () => calls.filter((c) => c.type === 'destroy').map((c) => c.publicId),
    reset: () => { calls.length = 0; },
    /** Environment for the API process: fake credentials + SDK pointed at this mock. */
    env: {
      ...FAKE_CLOUDINARY,
      CLOUDINARY_URL: `cloudinary://${FAKE_CLOUDINARY.CLOUDINARY_API_KEY}:${FAKE_CLOUDINARY.CLOUDINARY_API_SECRET}@${cloud}?upload_prefix=http://127.0.0.1:${port}`,
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
