/**
 * In-memory ObjectStore — ARCHITECTURAL TEST DOUBLE ONLY.
 *
 * This is not a production provider and is wired to nothing: the active
 * binding in objectStore.ts remains the local store. It exists so the
 * test battery can run the SAME contract checks against a store that has
 * no filesystem at all — which is what proves callers depend on the
 * provider-neutral interface rather than accidentally on disk paths,
 * synchronous I/O or fs.ReadStream. If a caller works against this store,
 * a future Azure Blob or S3 adapter can satisfy it too.
 *
 * Deliberately naive: a Map of Buffers, no persistence, no eviction.
 * Anything cleverer would make it a worse test double.
 */
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import {
  hashesEqual,
  materializeToTemp,
  normalizeKey,
  ObjectClass,
  ObjectMetadata,
  ObjectStore,
} from "./objectStore";

export class MemoryObjectStore implements ObjectStore {
  readonly kind = "memory-test-double";
  private objects = new Map<string, { body: Buffer; objectClass: ObjectClass; modifiedAt: string }>();

  async exists(key: string): Promise<boolean> {
    const k = normalizeKey(key);
    return k !== null && this.objects.has(k);
  }

  async get(key: string): Promise<Buffer | null> {
    const k = normalizeKey(key);
    if (!k) return null;
    const entry = this.objects.get(k);
    // A copy, so a caller mutating the returned Buffer cannot silently
    // rewrite "stored" bytes — remote stores have this property for free.
    return entry ? Buffer.from(entry.body) : null;
  }

  async metadata(key: string): Promise<ObjectMetadata | null> {
    const k = normalizeKey(key);
    if (!k) return null;
    const entry = this.objects.get(k);
    if (!entry) return null;
    return {
      key: k,
      size: entry.body.length,
      modifiedAt: entry.modifiedAt,
      sha256: createHash("sha256").update(entry.body).digest("hex"),
    };
  }

  async verifyHash(key: string, expectedSha256: string): Promise<boolean> {
    const meta = await this.metadata(key);
    return meta !== null && hashesEqual(meta.sha256, expectedSha256);
  }

  async openReadStream(key: string): Promise<Readable | null> {
    const body = await this.get(key);
    return body ? Readable.from(body) : null;
  }

  async put(key: string, body: Buffer, objectClass: ObjectClass): Promise<ObjectMetadata> {
    const k = normalizeKey(key);
    if (!k) throw new Error(`Invalid object key: ${key}`);
    if (objectClass === ObjectClass.IMMUTABLE && this.objects.has(k)) {
      throw new Error(`Immutable object already exists and cannot be replaced: ${k}`);
    }
    this.objects.set(k, { body: Buffer.from(body), objectClass, modifiedAt: new Date().toISOString() });
    return (await this.metadata(k))!;
  }

  async withLocalFile<T>(key: string, fn: (filePath: string) => Promise<T>): Promise<T> {
    const body = await this.get(key);
    if (!body) throw new Error(`Object not found: ${key}`);
    // Exactly what a remote adapter does: download to a temporary file,
    // lend the path for the callback's duration, remove it afterwards.
    return materializeToTemp(key, body, fn);
  }
}
