import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { parseTransform, snapWidth, derivedKey, validateKey, sign, BadRequest } from '../src/params.js';
import { createHandlers } from '../src/handler.js';

function memoryStore() {
  const objects = new Map();
  return {
    objects,
    gets: 0,
    async get(b, k) { this.gets++; return objects.get(`${b}/${k}`)?.body ?? null; },
    async head(b, k) { return objects.has(`${b}/${k}`); },
    async put(b, k, body, contentType) { objects.set(`${b}/${k}`, { body, contentType }); },
  };
}

const png = (w, h) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.5 } } }).png().toBuffer();

async function setup(secret) {
  const store = memoryStore();
  await store.put('src', 'products/shoe.png', await png(2000, 1000));
  const h = createHandlers({ store, sourceBucket: 'src', derivedBucket: 'out', secret, cdnBase: 'https://cdn.example.com' });
  return { store, h };
}

test('params snap widths, negotiate format, and reject junk', () => {
  assert.equal(snapWidth(300), 400);
  assert.equal(snapWidth(5000), 1600);
  assert.deepEqual(parseTransform({ w: '300' }, 'image/avif,image/webp,*/*'), { fit: 'inside', q: 80, w: 400, fmt: 'avif' });
  assert.equal(parseTransform({}, 'image/webp').fmt, 'webp');
  assert.equal(parseTransform({}, '').fmt, 'jpeg');
  assert.throws(() => parseTransform({ w: '12px' }), BadRequest);
  assert.throws(() => parseTransform({ q: '10' }), BadRequest);
  assert.throws(() => parseTransform({ fmt: 'gif' }), BadRequest);
  assert.throws(() => validateKey('../etc/passwd'), BadRequest);
});

test('derived keys are deterministic', () => {
  const spec = { w: 400, fit: 'inside', q: 80, fmt: 'jpeg' };
  assert.equal(derivedKey('a/b.png', spec), 'derived/a/b/w400_ho_inside_q80.jpg');
});

test('first request renders and inlines, second redirects to CDN', async () => {
  const { store, h } = await setup();
  const ev = { pathParameters: { key: 'products/shoe.png' }, queryStringParameters: { w: '640' }, headers: { accept: 'image/webp' } };
  const r1 = await h.http(ev);
  assert.equal(r1.statusCode, 200);
  assert.equal(r1.headers['Content-Type'], 'image/webp');
  const meta = await sharp(Buffer.from(r1.body, 'base64')).metadata();
  assert.equal(meta.width, 640);
  assert.equal(meta.height, 320);

  const r2 = await h.http(ev);
  assert.equal(r2.statusCode, 302);
  assert.equal(r2.headers.Location, 'https://cdn.example.com/derived/products/shoe/w640_ho_inside_q80.webp');
  assert.equal(store.gets, 1, 'original fetched only once');
});

test('jpeg output flattens alpha and never upscales', async () => {
  const { store, h } = await setup();
  await store.put('src', 'tiny.png', await png(50, 50));
  const r = await h.http({ pathParameters: { key: 'tiny.png' }, queryStringParameters: { w: '800', fmt: 'jpeg' } });
  const meta = await sharp(Buffer.from(r.body, 'base64')).metadata();
  assert.equal(meta.format, 'jpeg');
  assert.equal(meta.width, 50);
  assert.equal(meta.hasAlpha, false);
});

test('errors map to 400 / 404 / 422', async () => {
  const { store, h } = await setup();
  assert.equal((await h.http({ pathParameters: { key: 'x.png' }, queryStringParameters: { w: 'abc' } })).statusCode, 400);
  assert.equal((await h.http({ pathParameters: { key: 'missing.png' } })).statusCode, 404);
  await store.put('src', 'bad.png', Buffer.from('not an image'));
  assert.equal((await h.http({ pathParameters: { key: 'bad.png' } })).statusCode, 422);
});

test('signed URLs are enforced when a secret is set', async () => {
  const { h } = await setup('s3cret');
  const key = 'products/shoe.png';
  const query = { w: '256', fmt: 'png' };
  assert.equal((await h.http({ pathParameters: { key }, queryStringParameters: query })).statusCode, 403);
  const signed = { ...query, sig: sign('s3cret', key, query) };
  assert.equal((await h.http({ pathParameters: { key }, queryStringParameters: signed })).statusCode, 200);
  const tampered = { ...signed, w: '1600' };
  assert.equal((await h.http({ pathParameters: { key }, queryStringParameters: tampered })).statusCode, 403);
});

test('upload trigger pre-renders presets', async () => {
  const { store, h } = await setup();
  const r = await h.onUpload({ Records: [{ s3: { object: { key: 'products/shoe.png' } } }] });
  assert.equal(r.rendered.length, 3);
  const thumb = store.objects.get('out/derived/products/shoe/w256_h256_cover_q80.webp');
  const meta = await sharp(thumb.body).metadata();
  assert.deepEqual([meta.width, meta.height], [256, 256]);
});
