/**
 * Public entry point for the S3 storage adapter package.
 */

export interface StorageAdapter {
  get(key: string): Promise<Uint8Array | null>;
  put(key: string, data: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}
