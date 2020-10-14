# ImageForge

Portfolio reference implementation of a 2019 project, built to show an on-demand image resizing service for product photos.

**Stack:** AWS Lambda (Node 20, arm64), API Gateway, S3, Sharp (libvips), Serverless Framework.

## How it works
```
GET /img/products/shoe.png?w=640&fmt=webp&sig=…
  → API Gateway → Lambda `http`
      ├─ derived object already in S3? → 302 to the CDN copy
      └─ otherwise: fetch original → Sharp resize/encode → put into derived bucket → return inline (base64)
S3 ObjectCreated on originals → Lambda `onUpload` → pre-render thumbnail / listing / zoom presets
```

- **Bounded cache:** requested widths snap to a fixed ladder (64…1600), so clients can't create unlimited variants.
- **Format negotiation:** picks AVIF, then WebP, then JPEG based on the `Accept` header, and sets `Vary: Accept`.
- **Deterministic keys:** `derived/<path>/w640_ho_inside_q80.webp`, so each output is rendered only once.
- **Signed URLs:** an HMAC over the key and sorted query params means only URLs the app generates can trigger a render.
- **Safety:**
  - `limitInputPixels` guards against decompression bombs.
  - Key validation blocks path traversal.
  - Images are never upscaled.
  - EXIF orientation is applied and metadata is stripped.
- **Lambda limits:** outputs over about 5.5 MB redirect to the CDN instead of being inlined.

## Test
```bash
npm install && npm test   # real Sharp encoding against an in-memory S3 fake
```

## Deploy
```bash
aws ssm put-parameter --name /imageforge/dev/signing-secret --type SecureString --value "$(openssl rand -hex 32)"
npx serverless deploy --stage dev --param="cdnBase=https://dxxxx.cloudfront.net"
```
