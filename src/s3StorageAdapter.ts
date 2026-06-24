/**
 * AWS S3 (or S3-compatible) storage adapter that issues presigned PUT/GET URLs.
 *
 * Configuration via environment variables:
 *  - `S3_BUCKET`                     (required) target bucket name
 *  - `S3_REGION` / `AWS_REGION`      (required) bucket region
 *  - `S3_ENDPOINT`                   (optional) custom endpoint for S3-compatible
 *                                    stores such as MinIO
 *  - `S3_FORCE_PATH_STYLE`           (optional) "true" to use path-style addressing
 *                                    (required by most MinIO setups)
 *  - `AWS_ACCESS_KEY_ID` /
 *    `AWS_SECRET_ACCESS_KEY`         (optional) explicit credentials; when omitted
 *                                    the SDK default chain is used (IAM role, env,
 *                                    shared profile, etc.)
 *  - `S3_UPLOAD_URL_EXPIRY_SECONDS`  (optional) presigned PUT lifetime, default 900
 *  - `S3_DOWNLOAD_URL_EXPIRY_SECONDS`(optional) presigned GET lifetime, default 900
 */

import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { StorageAdapter } from './index.js';

const DEFAULT_UPLOAD_EXPIRY_SECONDS = 15 * 60; // 15 minutes
const DEFAULT_DOWNLOAD_EXPIRY_SECONDS = 15 * 60; // 15 minutes

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`${name} must be set to use the S3 storage adapter.`);
    }
    return value;
}

function parseExpirySeconds(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) {
        return fallback;
    }
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(
            `${name} must be a positive number of seconds (got "${raw}").`
        );
    }
    return Math.floor(parsed);
}

export class S3StorageAdapter implements StorageAdapter {
    private readonly client: S3Client;
    private readonly bucket: string;
    private readonly uploadExpirySeconds: number;
    private readonly downloadExpirySeconds: number;

    constructor() {
        this.bucket = requireEnv('S3_BUCKET');
        const region = process.env.S3_REGION || requireEnv('AWS_REGION');

        const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
        const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

        this.client = new S3Client({
            region,
            // Custom endpoint for S3-compatible stores (MinIO, etc.).
            ...(process.env.S3_ENDPOINT
                ? { endpoint: process.env.S3_ENDPOINT }
                : {}),
            forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
            // Only pass explicit credentials when both parts are present;
            // otherwise defer to the SDK default credential chain.
            ...(accessKeyId && secretAccessKey
                ? { credentials: { accessKeyId, secretAccessKey } }
                : {})
        });

        this.uploadExpirySeconds = parseExpirySeconds(
            'S3_UPLOAD_URL_EXPIRY_SECONDS',
            DEFAULT_UPLOAD_EXPIRY_SECONDS
        );
        this.downloadExpirySeconds = parseExpirySeconds(
            'S3_DOWNLOAD_URL_EXPIRY_SECONDS',
            DEFAULT_DOWNLOAD_EXPIRY_SECONDS
        );
    }

    async generateSignedUploadUrl(
        storageKey: string,
        mimeType: string
    ): Promise<{ uploadUrl: string }> {
        const command = new PutObjectCommand({
            Bucket: this.bucket,
            Key: storageKey,
            ContentType: mimeType
        });
        const uploadUrl = await getSignedUrl(this.client, command, {
            expiresIn: this.uploadExpirySeconds
        });
        return { uploadUrl };
    }

    async generateSignedDownloadUrl(
        storageKey: string
    ): Promise<{ downloadUrl: string; expiresAt: Date }> {
        const command = new GetObjectCommand({
            Bucket: this.bucket,
            Key: storageKey
        });
        const downloadUrl = await getSignedUrl(this.client, command, {
            expiresIn: this.downloadExpirySeconds
        });
        const expiresAt = new Date(
            Date.now() + this.downloadExpirySeconds * 1000
        );
        return { downloadUrl, expiresAt };
    }

    async getObject(storageKey: string): Promise<Buffer> {
        const res = await this.client.send(
            new GetObjectCommand({
                Bucket: this.bucket,
                Key: storageKey
            })
        );
        if (!res.Body) {
            throw new Error(`S3 object has no body: ${storageKey}`);
        }
        // SDK v3 stream → byte array. A missing key throws NoSuchKey above,
        // which the worker lets propagate so BullMQ retries.
        const bytes = await res.Body.transformToByteArray();
        return Buffer.from(bytes);
    }

    async putObject(
        storageKey: string,
        body: Buffer,
        contentType: string
    ): Promise<void> {
        await this.client.send(
            new PutObjectCommand({
                Bucket: this.bucket,
                Key: storageKey,
                Body: body,
                ContentType: contentType
            })
        );
    }

    async deleteObject(storageKey: string): Promise<void> {
        // S3 DeleteObject is idempotent: deleting a missing key returns 204,
        // so no special-casing of NoSuchKey is needed.
        await this.client.send(
            new DeleteObjectCommand({
                Bucket: this.bucket,
                Key: storageKey
            })
        );
    }

    async getObjectMetadata(
        storageKey: string
    ): Promise<{ size: number } | null> {
        try {
            const head = await this.client.send(
                new HeadObjectCommand({
                    Bucket: this.bucket,
                    Key: storageKey
                })
            );
            return { size: head.ContentLength ?? 0 };
        } catch (err: unknown) {
            // Object missing (never PUT, or PUT failed) → treat as absent.
            const meta = (err as { $metadata?: { httpStatusCode?: number } })
                .$metadata;
            const name = (err as { name?: string }).name;
            if (
                meta?.httpStatusCode === 404 ||
                name === 'NotFound' ||
                name === 'NoSuchKey'
            ) {
                return null;
            }
            throw err;
        }
    }
}
