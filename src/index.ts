/**
 * Public entry point for the S3 storage adapter package.
 */

export interface StorageAdapter {
    generateSignedUploadUrl(
        storageKey: string,
        mimeType: string
    ): Promise<{ uploadUrl: string }>;
    generateSignedDownloadUrl(
        storageKey: string
    ): Promise<{ downloadUrl: string; expiresAt: Date }>;
    /**
     * Returns size (bytes) of the stored object, or null if it does not
     * exist. Used to verify a client-reported upload actually landed before
     * an evidence record is marked COMPLETE.
     */
    getObjectMetadata(storageKey: string): Promise<{ size: number } | null>;
    /**
     * Downloads the full object bytes. Throws if the object does not exist —
     * the thumbnail worker relies on this so a not-yet-visible original
     * surfaces as a job error (BullMQ then retries with backoff).
     */
    getObject(storageKey: string): Promise<Buffer>;
    /**
     * Uploads object bytes under `storageKey` with the given content type.
     * Used by the thumbnail worker to store the resized output.
     */
    putObject(
        storageKey: string,
        body: Buffer,
        contentType: string
    ): Promise<void>;
    /**
     * Deletes the object at `storageKey`. Idempotent: deleting a missing
     * object is not an error. Used when an evidence file is removed.
     */
    deleteObject(storageKey: string): Promise<void>;
}
