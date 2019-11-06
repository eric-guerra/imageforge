import { createHmac, timingSafeEqual } from 'node:crypto';

export const ALLOWED_WIDTHS = [64, 128, 256, 400, 640, 800, 1080, 1600];
export const FORMATS = ['jpeg', 'webp', 'avif', 'png'];
export const FITS = ['cover', 'contain', 'inside'];

export class BadRequest extends Error {}

/**
 * Turn query params into a normalized transform spec. Widths snap to a fixed ladder so a client
 * can't fill the cache with 1600 slightly different sizes.
 */
export function parseTransform(query = {}, accept = '') {
  const spec = { fit: 'inside', q: 80 };
  if (query.w != null) spec.w = snapWidth(int(query.w, 'w'));
  if (query.h != null) {
    const h = int(query.h, 'h');
    if (h < 1 || h > 2000) throw new BadRequest('h must be 1..2000');
    spec.h = h;
  }
  if (query.fit != null) {
    if (!FITS.includes(query.fit)) throw new BadRequest(`fit must be one of ${FITS.join(',')}`);
    spec.fit = query.fit;
  }
  if (query.q != null) {
    const q = int(query.q, 'q');
    if (q < 30 || q > 95) throw new BadRequest('q must be 30..95');
    spec.q = q;
  }
  spec.fmt = query.fmt ?? negotiate(accept);
  if (!FORMATS.includes(spec.fmt)) throw new BadRequest(`fmt must be one of ${FORMATS.join(',')}`);
  return spec;
}

/** Pick the smallest format the browser says it accepts. */
export function negotiate(accept) {
  if (/image\/avif/.test(accept)) return 'avif';
  if (/image\/webp/.test(accept)) return 'webp';
  return 'jpeg';
}

export function snapWidth(w) {
  if (w < 1) throw new BadRequest('w must be positive');
  return ALLOWED_WIDTHS.find((a) => a >= w) ?? ALLOWED_WIDTHS.at(-1);
}

/** Deterministic cache key: same spec → same derived object. */
export function derivedKey(sourceKey, spec) {
  const parts = [`w${spec.w ?? 'o'}`, `h${spec.h ?? 'o'}`, spec.fit, `q${spec.q}`];
  const base = sourceKey.replace(/\.[^/.]+$/, '');
  return `derived/${base}/${parts.join('_')}.${spec.fmt === 'jpeg' ? 'jpg' : spec.fmt}`;
}

export function validateKey(key) {
  if (!key || key.length > 512 || key.includes('..') || key.startsWith('/') || !/^[\w\-./]+$/.test(key))
    throw new BadRequest('invalid image key');
  return key;
}

/** URLs are signed by the app server so only links we generate can trigger a resize. */
export function sign(secret, key, query) {
  const canonical = key + '?' + Object.keys(query).filter((k) => k !== 'sig').sort().map((k) => `${k}=${query[k]}`).join('&');
  return createHmac('sha256', secret).update(canonical).digest('base64url').slice(0, 22);
}

export function verify(secret, key, query) {
  if (!query.sig) return false;
  const a = Buffer.from(sign(secret, key, query));
  const b = Buffer.from(query.sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

function int(v, name) {
  if (!/^\d+$/.test(String(v))) throw new BadRequest(`${name} must be an integer`);
  return Number(v);
}
