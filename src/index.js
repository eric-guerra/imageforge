// Lambda entry points. Both functions share one bundle; serverless.yml picks the export.
import { S3Client, GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { createHandlers } from './handler.js';

const s3 = new S3Client({});

const store = {
  async get(Bucket, Key) {
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket, Key }));
      return Buffer.from(await r.Body.transformToByteArray());
    } catch (e) {
      if (e.name === 'NoSuchKey') return null;
      throw e;
    }
  },
  async head(Bucket, Key) {
    try {
      await s3.send(new HeadObjectCommand({ Bucket, Key }));
      return true;
    } catch (e) {
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return false;
      throw e;
    }
  },
  async put(Bucket, Key, Body, ContentType) {
    await s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType, CacheControl: 'public, max-age=31536000, immutable' }));
  },
};

const handlers = createHandlers({
  store,
  sourceBucket: process.env.SOURCE_BUCKET,
  derivedBucket: process.env.DERIVED_BUCKET,
  secret: process.env.SIGNING_SECRET,
  cdnBase: process.env.CDN_BASE,
  log: (o) => console.log(JSON.stringify(o)),
});

export const http = handlers.http;
export const onUpload = handlers.onUpload;
