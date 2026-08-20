import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env, storageBackend } from '../../config/index.js';
import { createModuleLogger } from '../logger/index.js';

const log = createModuleLogger('storage');

export interface StoredObject {
  body: Buffer;
  contentType: string;
  sizeBytes: number;
}

const s3 =
  storageBackend === 's3'
    ? new S3Client({
        region: env.STORAGE_REGION,
        ...(env.STORAGE_ENDPOINT ? { endpoint: env.STORAGE_ENDPOINT } : {}),
        forcePathStyle: env.STORAGE_FORCE_PATH_STYLE,
        credentials: {
          accessKeyId: env.STORAGE_ACCESS_KEY_ID ?? '',
          secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY ?? '',
        },
      })
    : null;

const bucket = env.STORAGE_BUCKET ?? '';
const localRoot = resolve(env.STORAGE_LOCAL_DIR);

/**
 * Object keys are generated, never derived from a filename: a caller-supplied
 * name could contain path separators or traversal sequences. This still refuses
 * anything unexpected, because the cost of being wrong is arbitrary file write.
 */
const SAFE_KEY = /^[A-Za-z0-9/_.-]{8,255}$/;

function assertSafeKey(key: string): void {
  if (!SAFE_KEY.test(key) || key.includes('..') || key.startsWith('/')) {
    throw new Error(`unsafe storage key: ${key}`);
  }
}

/** `tickets/<ticketId>/<uuid>/<sanitised filename>`. */
export function buildStorageKey(ticketId: string, filename: string): string {
  const safeName =
    filename
      .replace(/[^A-Za-z0-9_.-]/g, '_')
      .replace(/_{2,}/g, '_')
      .slice(-80) || 'file';

  return `tickets/${ticketId}/${randomUUID()}/${safeName}`;
}

function localPathFor(key: string): string {
  assertSafeKey(key);
  const path = resolve(join(localRoot, normalize(key)));

  // Belt and braces: even with a validated key, never write outside the root.
  if (path !== localRoot && !path.startsWith(localRoot + sep)) {
    throw new Error(`storage key escapes the root: ${key}`);
  }
  return path;
}

/**
 * Presigned upload URL, or null when the backend cannot issue one. Null means
 * the caller should route the upload through the API instead — the local backend
 * has no signing endpoint of its own.
 */
export async function presignUpload(
  key: string,
  contentType: string,
): Promise<{ url: string; expiresAt: Date } | null> {
  if (!s3) return null;
  assertSafeKey(key);

  const url = await getSignedUrl(
    s3,
    new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
    { expiresIn: env.UPLOAD_URL_TTL_SECONDS },
  );

  return { url, expiresAt: new Date(Date.now() + env.UPLOAD_URL_TTL_SECONDS * 1000) };
}

export async function presignDownload(
  key: string,
  filename: string,
): Promise<{ url: string; expiresAt: Date } | null> {
  if (!s3) return null;
  assertSafeKey(key);

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: bucket,
      Key: key,
      // Forces a download with the original name rather than rendering in-browser.
      ResponseContentDisposition: `attachment; filename="${filename.replace(/"/g, '')}"`,
    }),
    { expiresIn: env.UPLOAD_URL_TTL_SECONDS },
  );

  return { url, expiresAt: new Date(Date.now() + env.UPLOAD_URL_TTL_SECONDS * 1000) };
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<string> {
  assertSafeKey(key);
  const checksum = createHash('sha256').update(body).digest('hex');

  if (s3) {
    await s3.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
  } else {
    const path = localPathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    // The content type is not recoverable from disk, so it is kept in the row.
    log.debug('stored object on local disk', { key, sizeBytes: body.byteLength });
  }

  return checksum;
}

export async function getObject(key: string, contentType: string): Promise<StoredObject> {
  assertSafeKey(key);

  if (s3) {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = Buffer.from(await response.Body!.transformToByteArray());
    return {
      body,
      contentType: response.ContentType ?? contentType,
      sizeBytes: body.byteLength,
    };
  }

  const body = await readFile(localPathFor(key));
  return { body, contentType, sizeBytes: body.byteLength };
}

/** Size in bytes, or null when the object is absent. */
export async function objectSize(key: string): Promise<number | null> {
  assertSafeKey(key);

  try {
    if (s3) {
      const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return head.ContentLength ?? null;
    }
    return (await stat(localPathFor(key))).size;
  } catch {
    return null;
  }
}

export async function deleteObject(key: string): Promise<void> {
  assertSafeKey(key);

  if (s3) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    return;
  }
  await rm(localPathFor(key), { force: true });
}

/** True when the backend can hand the client a URL to upload to directly. */
export const supportsPresigning = storageBackend === 's3';

export { storageBackend };
