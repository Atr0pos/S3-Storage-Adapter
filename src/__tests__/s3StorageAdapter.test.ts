import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// getSignedUrl is a free function (not a client method) so mockClient can't
// intercept it — mock the module directly.
vi.mock('@aws-sdk/s3-request-presigner', () => ({
    getSignedUrl: vi.fn()
}));

const signedUrlMock = vi.mocked(getSignedUrl);
const s3Mock = mockClient(S3Client);

// Imported after the mocks above are registered (vi.mock is hoisted anyway,
// but keep the order explicit for readers).
import { S3StorageAdapter } from '../s3StorageAdapter.js';

const BASE_ENV = {
    S3_BUCKET: 'test-bucket',
    S3_REGION: 'eu-west-2'
};

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
    savedEnv = process.env;
    // Fresh env per test: only the keys a test opts into are present.
    process.env = { ...BASE_ENV };
    s3Mock.reset();
    signedUrlMock.mockReset();
});

afterEach(() => {
    process.env = savedEnv;
});

describe('constructor / configuration', () => {
    it('throws when S3_BUCKET is missing', () => {
        delete process.env.S3_BUCKET;
        expect(() => new S3StorageAdapter()).toThrow(
            'S3_BUCKET must be set to use the S3 storage adapter.'
        );
    });

    it('throws when neither S3_REGION nor AWS_REGION is set', () => {
        delete process.env.S3_REGION;
        expect(() => new S3StorageAdapter()).toThrow(
            'AWS_REGION must be set to use the S3 storage adapter.'
        );
    });

    it('falls back to AWS_REGION when S3_REGION is absent', () => {
        delete process.env.S3_REGION;
        process.env.AWS_REGION = 'us-east-1';
        expect(() => new S3StorageAdapter()).not.toThrow();
    });

    it('throws when an expiry env var is non-numeric', () => {
        process.env.S3_UPLOAD_URL_EXPIRY_SECONDS = 'abc';
        expect(() => new S3StorageAdapter()).toThrow(
            'S3_UPLOAD_URL_EXPIRY_SECONDS must be a positive number of seconds (got "abc").'
        );
    });

    it('throws when an expiry env var is zero or negative', () => {
        process.env.S3_DOWNLOAD_URL_EXPIRY_SECONDS = '0';
        expect(() => new S3StorageAdapter()).toThrow(
            'S3_DOWNLOAD_URL_EXPIRY_SECONDS must be a positive number of seconds (got "0").'
        );
    });
});

describe('generateSignedUploadUrl', () => {
    it('signs a PutObjectCommand and returns the url', async () => {
        signedUrlMock.mockResolvedValue('https://signed.put/url');
        const adapter = new S3StorageAdapter();

        const result = await adapter.generateSignedUploadUrl(
            'key/file.png',
            'image/png'
        );

        expect(result).toEqual({ uploadUrl: 'https://signed.put/url' });
        expect(signedUrlMock).toHaveBeenCalledTimes(1);
        const [, command, opts] = signedUrlMock.mock.calls[0]!;
        expect(command).toBeInstanceOf(PutObjectCommand);
        expect(command.input).toMatchObject({
            Bucket: 'test-bucket',
            Key: 'key/file.png',
            ContentType: 'image/png'
        });
        expect(opts).toEqual({ expiresIn: 900 });
    });

    it('uses the configured upload expiry', async () => {
        process.env.S3_UPLOAD_URL_EXPIRY_SECONDS = '120';
        signedUrlMock.mockResolvedValue('https://signed.put/url');
        const adapter = new S3StorageAdapter();

        await adapter.generateSignedUploadUrl('k', 'image/png');

        const [, , opts] = signedUrlMock.mock.calls[0]!;
        expect(opts).toEqual({ expiresIn: 120 });
    });

    it('floors a fractional expiry', async () => {
        process.env.S3_UPLOAD_URL_EXPIRY_SECONDS = '90.9';
        signedUrlMock.mockResolvedValue('u');
        const adapter = new S3StorageAdapter();

        await adapter.generateSignedUploadUrl('k', 'image/png');

        const [, , opts] = signedUrlMock.mock.calls[0]!;
        expect(opts).toEqual({ expiresIn: 90 });
    });
});

describe('generateSignedDownloadUrl', () => {
    it('signs a GetObjectCommand and returns url + expiresAt', async () => {
        vi.useFakeTimers();
        const now = new Date('2026-06-24T12:00:00.000Z');
        vi.setSystemTime(now);
        signedUrlMock.mockResolvedValue('https://signed.get/url');
        const adapter = new S3StorageAdapter();

        const result = await adapter.generateSignedDownloadUrl('key/file.png');

        expect(result.downloadUrl).toBe('https://signed.get/url');
        expect(result.expiresAt).toEqual(new Date(now.getTime() + 900 * 1000));

        const [, command, opts] = signedUrlMock.mock.calls[0]!;
        expect(command).toBeInstanceOf(GetObjectCommand);
        expect(command.input).toMatchObject({
            Bucket: 'test-bucket',
            Key: 'key/file.png'
        });
        expect(opts).toEqual({ expiresIn: 900 });
        vi.useRealTimers();
    });

    it('uses the configured download expiry for both the signature and expiresAt', async () => {
        vi.useFakeTimers();
        const now = new Date('2026-06-24T12:00:00.000Z');
        vi.setSystemTime(now);
        process.env.S3_DOWNLOAD_URL_EXPIRY_SECONDS = '300';
        signedUrlMock.mockResolvedValue('u');
        const adapter = new S3StorageAdapter();

        const result = await adapter.generateSignedDownloadUrl('k');

        const [, , opts] = signedUrlMock.mock.calls[0]!;
        expect(opts).toEqual({ expiresIn: 300 });
        expect(result.expiresAt).toEqual(new Date(now.getTime() + 300 * 1000));
        vi.useRealTimers();
    });
});

describe('getObject', () => {
    it('returns the object bytes as a Buffer', async () => {
        const payload = Uint8Array.from([1, 2, 3, 4]);
        s3Mock.on(GetObjectCommand).resolves({
            Body: {
                transformToByteArray: () => Promise.resolve(payload)
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        const adapter = new S3StorageAdapter();

        const buf = await adapter.getObject('key/file.bin');

        expect(Buffer.isBuffer(buf)).toBe(true);
        expect(buf).toEqual(Buffer.from(payload));
        const call = s3Mock.commandCalls(GetObjectCommand)[0]!;
        expect(call.args[0].input).toMatchObject({
            Bucket: 'test-bucket',
            Key: 'key/file.bin'
        });
    });

    it('throws when the response has no body', async () => {
        s3Mock.on(GetObjectCommand).resolves({});
        const adapter = new S3StorageAdapter();

        await expect(adapter.getObject('missing')).rejects.toThrow(
            'S3 object has no body: missing'
        );
    });

    it('propagates a NoSuchKey error from the SDK', async () => {
        const err = Object.assign(new Error('not here'), {
            name: 'NoSuchKey'
        });
        s3Mock.on(GetObjectCommand).rejects(err);
        const adapter = new S3StorageAdapter();

        await expect(adapter.getObject('missing')).rejects.toThrow('not here');
    });
});

describe('putObject', () => {
    it('sends a PutObjectCommand with the body and content type', async () => {
        s3Mock.on(PutObjectCommand).resolves({});
        const adapter = new S3StorageAdapter();
        const body = Buffer.from('hello');

        await adapter.putObject('key/out.txt', body, 'text/plain');

        const call = s3Mock.commandCalls(PutObjectCommand)[0]!;
        expect(call.args[0].input).toMatchObject({
            Bucket: 'test-bucket',
            Key: 'key/out.txt',
            Body: body,
            ContentType: 'text/plain'
        });
    });
});

describe('deleteObject', () => {
    it('sends a DeleteObjectCommand', async () => {
        s3Mock.on(DeleteObjectCommand).resolves({});
        const adapter = new S3StorageAdapter();

        await adapter.deleteObject('key/gone.txt');

        const call = s3Mock.commandCalls(DeleteObjectCommand)[0]!;
        expect(call.args[0].input).toMatchObject({
            Bucket: 'test-bucket',
            Key: 'key/gone.txt'
        });
    });

    it('does not throw on a successful (idempotent) delete', async () => {
        s3Mock.on(DeleteObjectCommand).resolves({});
        const adapter = new S3StorageAdapter();
        await expect(adapter.deleteObject('whatever')).resolves.toBeUndefined();
    });
});

describe('getObjectMetadata', () => {
    it('returns the object size from ContentLength', async () => {
        s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 2048 });
        const adapter = new S3StorageAdapter();

        const meta = await adapter.getObjectMetadata('key/file.bin');

        expect(meta).toEqual({ size: 2048 });
        const call = s3Mock.commandCalls(HeadObjectCommand)[0]!;
        expect(call.args[0].input).toMatchObject({
            Bucket: 'test-bucket',
            Key: 'key/file.bin'
        });
    });

    it('defaults size to 0 when ContentLength is absent', async () => {
        s3Mock.on(HeadObjectCommand).resolves({});
        const adapter = new S3StorageAdapter();

        const meta = await adapter.getObjectMetadata('key/file.bin');

        expect(meta).toEqual({ size: 0 });
    });

    it('returns null on a 404 status code', async () => {
        const err = Object.assign(new Error('not found'), {
            $metadata: { httpStatusCode: 404 }
        });
        s3Mock.on(HeadObjectCommand).rejects(err);
        const adapter = new S3StorageAdapter();

        await expect(adapter.getObjectMetadata('missing')).resolves.toBeNull();
    });

    it('returns null on a NotFound error name', async () => {
        const err = Object.assign(new Error('nf'), { name: 'NotFound' });
        s3Mock.on(HeadObjectCommand).rejects(err);
        const adapter = new S3StorageAdapter();

        await expect(adapter.getObjectMetadata('missing')).resolves.toBeNull();
    });

    it('returns null on a NoSuchKey error name', async () => {
        const err = Object.assign(new Error('nsk'), { name: 'NoSuchKey' });
        s3Mock.on(HeadObjectCommand).rejects(err);
        const adapter = new S3StorageAdapter();

        await expect(adapter.getObjectMetadata('missing')).resolves.toBeNull();
    });

    it('rethrows non-404 errors (e.g. access denied)', async () => {
        const err = Object.assign(new Error('denied'), {
            name: 'AccessDenied',
            $metadata: { httpStatusCode: 403 }
        });
        s3Mock.on(HeadObjectCommand).rejects(err);
        const adapter = new S3StorageAdapter();

        await expect(adapter.getObjectMetadata('locked')).rejects.toThrow(
            'denied'
        );
    });
});
