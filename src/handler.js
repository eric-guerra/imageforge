import { BadRequest, derivedKey, parseTransform, validateKey, verify } from './params.js';
import { transform } from './transform.js';

const LAMBDA_BODY_LIMIT = 5_500_000; // API Gateway caps responses at 6 MB after base64
const PRESETS = [
  { w: 256, fit: 'cover', h: 256, q: 80, fmt: 'webp' },
  { w: 640, fit: 'inside', q: 80, fmt: 'webp' },
  { w: 1080, fit: 'inside', q: 80, fmt: 'jpeg' },
];

/**
 * @param {object} deps
 * @param {{ get(bucket,key): Promise<Buffer|null>, head(bucket,key): Promise<boolean>, put(bucket,key,body,contentType): Promise<void> }} deps.store
 */
export function createHandlers({ store, sourceBucket, derivedBucket, secret, cdnBase, log = () => {} }) {
  async function render(key, spec) {
    const out = derivedKey(key, spec);
    if (await store.head(derivedBucket, out)) return { key: out, cached: true };
    const original = await store.get(sourceBucket, key);
    if (!original) return null;
    const t0 = Date.now();
    const result = await transform(original, spec);
    await store.put(derivedBucket, out, result.body, result.contentType);
    log({ msg: 'rendered', key, out, ms: Date.now() - t0, bytes: result.body.length });
    return { key: out, cached: false, result };
  }

  /** API Gateway (REST, proxy integration): GET /img/{key+}?w=&h=&fit=&q=&fmt=&sig= */
  async function http(event) {
    try {
      const key = validateKey(event.pathParameters?.key);
      const query = event.queryStringParameters ?? {};
      if (secret && !verify(secret, key, query)) return text(403, 'bad signature');
      const accept = event.headers?.accept ?? event.headers?.Accept ?? '';
      const spec = parseTransform(query, accept);
      const r = await render(key, spec);
      if (!r) return text(404, 'not found');

      const headers = { Vary: 'Accept', 'Cache-Control': 'public, max-age=31536000, immutable' };
      // Cached or too big to inline: send the client to the CDN copy instead.
      if (r.cached || r.result.body.length > LAMBDA_BODY_LIMIT)
        return { statusCode: 302, headers: { ...headers, Location: `${cdnBase}/${r.key}` }, body: '' };
      return {
        statusCode: 200,
        headers: { ...headers, 'Content-Type': r.result.contentType },
        body: r.result.body.toString('base64'),
        isBase64Encoded: true,
      };
    } catch (e) {
      if (e instanceof BadRequest) return text(400, e.message);
      if (/unsupported image format|Input buffer|pixel limit/i.test(e.message)) return text(422, 'unprocessable image');
      log({ msg: 'error', error: e.message });
      return text(500, 'internal error');
    }
  }

  /** S3 ObjectCreated trigger on the source bucket: warm the common sizes. */
  async function onUpload(event) {
    const done = [];
    for (const rec of event.Records ?? []) {
      const key = decodeURIComponent(rec.s3.object.key.replace(/\+/g, ' '));
      try { validateKey(key); } catch { log({ msg: 'skip', key }); continue; }
      for (const spec of PRESETS) {
        const r = await render(key, spec);
        if (r) done.push(r.key);
      }
    }
    return { rendered: done };
  }

  return { http, onUpload };
}

function text(statusCode, body) {
  return { statusCode, headers: { 'Content-Type': 'text/plain' }, body };
}
