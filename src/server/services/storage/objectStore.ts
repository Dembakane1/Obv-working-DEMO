/**
 * Object storage boundary.
 *
 * WHAT WAS ALREADY TRUE: OBV never persisted absolute host paths. Every
 * artifact reference in the database is already a LOGICAL key —
 * `/worm/<file>`, `/uploads/<file>`, `audit-packages/<id>/<file>` — that
 * gets resolved against the data root at read time. That is the single
 * most important precondition for moving artifacts to object storage, and
 * it was satisfied before this module existed.
 *
 * WHAT WAS MISSING: the resolution rules were restated in several places,
 * so "where does this key live?" had no single answer to change. This
 * module is that answer. It does not move data, does not alter any
 * stored key, and does not change what any existing caller reads — the
 * local implementation reproduces the existing rules exactly.
 *
 * IMMUTABILITY (WORM). The governance layer depends on an immutability
 * GUARANTEE, never on a vendor. `ObjectClass.IMMUTABLE` means: once
 * written, the bytes at this key never change and the object is never
 * overwritten in place. Today that is enforced by write-once local files
 * plus the Evidence Ledger's hash chain, which is what actually detects
 * tampering — the ledger is the proof, the storage class is the policy.
 * A future adapter maps the same guarantee onto Azure Blob immutability
 * policies or S3 Object Lock. No governed code names a vendor.
 *
 * NOT IMPLEMENTED HERE, DELIBERATELY: no Azure, S3 or network adapter.
 * An adapter with no credentials, no configuration and no caller is
 * decoration, not portability. docs/CLOUD_PORTABILITY.md records the
 * mapping each future adapter must satisfy.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { DATA_DIR, REPORTS_DIR } from "../../db/index";

/** How OBV treats an object, independent of where it physically lives. */
export enum ObjectClass {
  /** Write-once. Never overwritten, never mutated. Evidence and packages. */
  IMMUTABLE = "IMMUTABLE",
  /** Regenerable derivative — safe to overwrite. Rendered reports. */
  DERIVED = "DERIVED",
}

export interface ObjectMetadata {
  key: string;
  size: number;
  /** Last modification time, ISO-8601. */
  modifiedAt: string;
  sha256: string;
}

/**
 * The contract a storage backend must satisfy. Kept deliberately small:
 * every method here has a real caller or a real migration reason, and a
 * future AzureBlobObjectStore / S3ObjectStore has to implement exactly
 * this and nothing more.
 */
export interface ObjectStore {
  readonly kind: string;
  exists(key: string): boolean;
  get(key: string): Buffer | null;
  metadata(key: string): ObjectMetadata | null;
  /** True when the stored bytes still hash to `expected`. */
  verifyHash(key: string, expected: string): boolean;
  openReadStream(key: string): fs.ReadStream | null;
  /** Write-once for IMMUTABLE: refuses to replace an existing object. */
  put(key: string, body: Buffer, objectClass: ObjectClass): ObjectMetadata;
}

/**
 * Keys are relative, POSIX-style and rooted at the data directory:
 * `worm/<file>`, `uploads/<file>`, `reports/<file>`,
 * `audit-packages/<id>/<file>`.
 *
 * Served evidence paths (`/worm/<file>`) and bare filenames both appear
 * in existing records, so normalisation accepts them and produces the
 * canonical key. This is the only place that mapping is expressed.
 */
export function normalizeKey(reference: string, defaultPrefix?: string): string | null {
  if (!reference) return null;
  let ref = reference.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!ref.includes("/") && defaultPrefix) ref = `${defaultPrefix}/${ref}`;
  // Reject traversal outright rather than resolving and hoping: a key is
  // a logical name, and a logical name never contains "..".
  if (ref.split("/").some((seg) => seg === "..")) return null;
  return ref || null;
}

class LocalObjectStore implements ObjectStore {
  readonly kind = "local-filesystem";

  /**
   * The one place a logical key becomes a physical location. Everything
   * stays under the data root; `demo-evidence` is the single exception —
   * it is bundled read-only demonstration media that ships inside the
   * image, not tenant data, and it is served from `public/`.
   */
  private resolve(key: string): string | null {
    const normalized = normalizeKey(key);
    if (!normalized) return null;
    let root = DATA_DIR;
    let relative = normalized;
    if (normalized.startsWith("demo-evidence/")) {
      root = path.join(process.cwd(), "public");
    } else if (normalized.startsWith("reports/")) {
      // Reports honour OBV_REPORT_STORAGE_PATH, which may point outside
      // the data root — so the report root is asked for, not assumed.
      root = REPORTS_DIR;
      relative = normalized.slice("reports/".length);
    }
    const full = path.resolve(root, relative);
    // Defence in depth: even with traversal rejected above, never return a
    // path that escaped the intended root.
    const rootWithSep = path.resolve(root) + path.sep;
    return full.startsWith(rootWithSep) ? full : null;
  }

  /** Exposed for callers that still need a disk path (PDF render, zip). */
  physicalPath(key: string): string | null {
    return this.resolve(key);
  }

  exists(key: string): boolean {
    const p = this.resolve(key);
    return p !== null && fs.existsSync(p) && fs.statSync(p).isFile();
  }

  get(key: string): Buffer | null {
    const p = this.resolve(key);
    if (!p || !fs.existsSync(p)) return null;
    try {
      return fs.readFileSync(p);
    } catch {
      return null;
    }
  }

  metadata(key: string): ObjectMetadata | null {
    const p = this.resolve(key);
    if (!p || !fs.existsSync(p)) return null;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return null;
      return {
        key: normalizeKey(key)!,
        size: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
        sha256: createHash("sha256").update(fs.readFileSync(p)).digest("hex"),
      };
    } catch {
      return null;
    }
  }

  verifyHash(key: string, expected: string): boolean {
    const meta = this.metadata(key);
    if (!meta || !expected) return false;
    // Length-checked comparison: hex digests of equal length, compared in
    // full rather than short-circuiting on a prefix.
    const a = meta.sha256.toLowerCase();
    const b = expected.toLowerCase();
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  }

  openReadStream(key: string): fs.ReadStream | null {
    const p = this.resolve(key);
    if (!p || !fs.existsSync(p)) return null;
    return fs.createReadStream(p);
  }

  put(key: string, body: Buffer, objectClass: ObjectClass): ObjectMetadata {
    const p = this.resolve(key);
    if (!p) throw new Error(`Invalid object key: ${key}`);
    if (objectClass === ObjectClass.IMMUTABLE && fs.existsSync(p)) {
      // The WORM guarantee, enforced rather than assumed. A future
      // immutable-blob adapter maps this refusal onto a retention policy.
      throw new Error(`Immutable object already exists and cannot be replaced: ${key}`);
    }
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return this.metadata(key)!;
  }
}

/**
 * The active store. A future deployment swaps this one binding — every
 * caller above it is already written against the interface.
 */
export const objectStore = new LocalObjectStore();

/**
 * Resolve a served evidence reference (`/worm/x.jpg`, `/uploads/x.jpg`,
 * `/demo-evidence/x.jpg`) to its object key.
 *
 * Evidence records store served paths, not keys, and this milestone does
 * not rewrite stored records — so the mapping lives here, in the storage
 * boundary, instead of being restated by each caller.
 */
export function evidenceKey(servedPath: string): string | null {
  if (!servedPath) return null;
  for (const prefix of ["/worm/", "/uploads/", "/demo-evidence/"]) {
    if (servedPath.startsWith(prefix)) {
      return `${prefix.replace(/\//g, "")}/${path.basename(servedPath)}`;
    }
  }
  return null;
}
