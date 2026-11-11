import { Files } from 'files-sdk';
import { neon } from 'files-sdk/neon';

export const objectStorageBucket = process.env.NEON_STORAGE_BUCKET || 'cafe-menu-images';
// Netlify reserves the AWS_* prefix for platform variables. Let the app accept
// custom names there, then expose them to the Neon Files adapter as AWS_*.
const storageAccessKeyId = process.env.NEON_S3_ACCESS_KEY_ID || process.env.AWS_ACCESS_KEY_ID;
const storageSecretAccessKey = process.env.NEON_S3_SECRET_ACCESS_KEY || process.env.AWS_SECRET_ACCESS_KEY;
const storageEndpoint = process.env.NEON_S3_ENDPOINT || process.env.AWS_ENDPOINT_URL_S3;
const storageRegion = process.env.NEON_S3_REGION || process.env.AWS_REGION;
if (storageAccessKeyId) process.env.AWS_ACCESS_KEY_ID = storageAccessKeyId;
if (storageSecretAccessKey) process.env.AWS_SECRET_ACCESS_KEY = storageSecretAccessKey;
if (storageEndpoint) process.env.AWS_ENDPOINT_URL_S3 = storageEndpoint;
if (storageRegion) process.env.AWS_REGION = storageRegion;

const storageConfigured = Boolean(
  storageAccessKeyId && storageSecretAccessKey && storageEndpoint && storageRegion,
);

const files = storageConfigured
  ? new Files({ adapter: neon({ bucket: objectStorageBucket }) })
  : null;

export function isObjectStorageConfigured() {
  return files !== null;
}

export async function storePublicImage(key: string, body: Buffer, contentType: string) {
  if (!files) throw new Error('Neon Object Storage is not configured.');

  await files.upload(key, body, {
    contentType,
    cacheControl: 'public, max-age=31536000, immutable',
  });

  const endpoint = storageEndpoint!.replace(/\/+$/, '');
  const objectPath = [objectStorageBucket, ...key.split('/')].map(encodeURIComponent).join('/');
  return `${endpoint}/${objectPath}`;
}
