/**
 * Example: using the S3 storage adapter directly.
 *
 * Before running, set the required environment variables (see
 * `s3StorageAdapter.ts` for the full list):
 *
 *   export S3_BUCKET=my-evidence-bucket
 *   export S3_REGION=eu-west-2
 *   # optional explicit credentials (otherwise SDK default chain is used)
 *   export AWS_ACCESS_KEY_ID=...
 *   export AWS_SECRET_ACCESS_KEY=...
 *
 * Run with: `npx tsx src/example/basicUsage.ts`
 */

import { S3StorageAdapter } from '../s3StorageAdapter.js';
import type { StorageAdapter } from '../index.js';

// Program against the interface, not the concrete class — swap S3 for any
// other StorageAdapter without touching call sites.
const storage: StorageAdapter = new S3StorageAdapter();

async function main(): Promise<void> {
    const storageKey = 'evidence/2026/report.pdf';

    // 1. Hand a browser a presigned PUT URL so it can upload directly to S3,
    //    bypassing your server.
    const { uploadUrl } = await storage.generateSignedUploadUrl(
        storageKey,
        'application/pdf'
    );
    console.log(
        'PUT to this URL with Content-Type application/pdf:\n',
        uploadUrl
    );

    // 2. Verify the upload actually landed before marking a record complete.
    //    getObjectMetadata returns null when the key is absent.
    const meta = await storage.getObjectMetadata(storageKey);
    if (!meta) {
        console.log('Upload not visible yet — client has not finished PUT.');
        return;
    }
    console.log(`Object present, ${meta.size} bytes.`);

    // 3. Issue a presigned GET URL for download, with its expiry timestamp.
    const { downloadUrl, expiresAt } =
        await storage.generateSignedDownloadUrl(storageKey);
    console.log('Download URL:\n', downloadUrl);
    console.log('Valid until:', expiresAt.toISOString());

    // 4. Server-side download: pull the bytes into a Buffer. Throws if the
    //    object is missing.
    const bytes = await storage.getObject(storageKey);
    console.log(`Downloaded ${bytes.byteLength} bytes server-side.`);

    // 5. Server-side upload: e.g. store a derived/processed artifact.
    const thumbnail = Buffer.from('fake-thumbnail-bytes');
    await storage.putObject(
        'evidence/2026/report.thumb.png',
        thumbnail,
        'image/png'
    );
    console.log('Thumbnail stored.');

    // 6. Delete. Idempotent — deleting a missing key is not an error.
    await storage.deleteObject(storageKey);
    console.log('Original deleted.');
}
