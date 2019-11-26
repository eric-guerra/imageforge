import sharp from 'sharp';

export const MAX_INPUT_PIXELS = 40_000_000; // ~ 7700x5200; guards against decompression bombs

const CONTENT_TYPES = { jpeg: 'image/jpeg', webp: 'image/webp', avif: 'image/avif', png: 'image/png' };

export async function transform(input, spec) {
  let img = sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error' })
    .rotate() // honour EXIF orientation, then strip metadata on output
    .resize({ width: spec.w, height: spec.h, fit: spec.fit, withoutEnlargement: true });

  switch (spec.fmt) {
    case 'jpeg': img = img.flatten({ background: '#ffffff' }).jpeg({ quality: spec.q, mozjpeg: true }); break;
    case 'webp': img = img.webp({ quality: spec.q }); break;
    case 'avif': img = img.avif({ quality: Math.max(30, spec.q - 20) }); break;
    case 'png': img = img.png({ compressionLevel: 9 }); break;
  }
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  return { body: data, contentType: CONTENT_TYPES[spec.fmt], width: info.width, height: info.height };
}
