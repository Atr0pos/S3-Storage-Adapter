/**
 * Example: wrapping the storage adapter in a small service, the way an HTTP
 * layer or worker would consume it.
 *
 * The service depends on the StorageAdapter *interface*, so tests can inject a
 * fake and production injects S3StorageAdapter. No HTTP framework needed to
 * show the shape.
 */

import { S3StorageAdapter } from '../s3StorageAdapter.js';
import type { StorageAdapter } from '../index.js';

export class EvidenceService {
    // Injected dependency — decoupled from S3 specifics.
    constructor(private readonly storage: StorageAdapter) {}

    /** Build the storage key from an evidence id. */
    private keyFor(evidenceId: string): string {
        return `evidence/${evidenceId}`;
    }

    /** Step 1 of a direct-to-S3 upload: client asks for a URL. */
    async requestUpload(
        evidenceId: string,
        mimeType: string
    ): Promise<{ uploadUrl: string }> {
        return this.storage.generateSignedUploadUrl(
            this.keyFor(evidenceId),
            mimeType
        );
    }

    /**
     * Step 2: client reports the upload finished. Confirm the bytes really
     * landed before trusting the client — returns the byte size or throws.
     */
    async confirmUpload(evidenceId: string): Promise<number> {
        const meta = await this.storage.getObjectMetadata(
            this.keyFor(evidenceId)
        );
        if (!meta) {
            throw new Error(
                `Upload for ${evidenceId} not found in storage; rejecting.`
            );
        }
        return meta.size;
    }

    /** Produce a time-limited download link for the client. */
    async getDownloadLink(
        evidenceId: string
    ): Promise<{ downloadUrl: string; expiresAt: Date }> {
        return this.storage.generateSignedDownloadUrl(this.keyFor(evidenceId));
    }

    /** Remove an evidence file. Idempotent. */
    async remove(evidenceId: string): Promise<void> {
        await this.storage.deleteObject(this.keyFor(evidenceId));
    }
}

// --- Wiring -------------------------------------------------------------

// Production wiring: the only place that knows the concrete adapter.
export function createEvidenceService(): EvidenceService {
    return new EvidenceService(new S3StorageAdapter());
}

// In tests you would instead do:
//   const fake: StorageAdapter = { generateSignedUploadUrl: ..., ... };
//   const service = new EvidenceService(fake);
