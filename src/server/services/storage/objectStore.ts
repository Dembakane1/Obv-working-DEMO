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
 * THE CONTRACT IS ASYNCHRONOUS AND PATH-FREE. A real remote store (Azure
 * Blob, S3, an S3-compatible private store) performs network I/O and has
 * no host filesystem path to offer, so the provider-neutral interface
 * promises neither: every method returns a Promise, streams are generic
 * `Readable`, and no method exposes where bytes physically live. The
 * local implementation keeps its synchronous filesystem work as an
 * internal detail behind that contract.
 *
 * LOCAL FILES ARE A CAPABILITY, NOT A LEAK. A few infrastructure
 * operations genuinely need a file on disk (ZIP assembly, Chromium/PDF
 * tooling, filename-only libraries). For those, `withLocalFile` hands the
 * caller a path that is valid only for the duration of the callback: the
 * local store lends its original file, and a future remote store
 * downloads to a temporary file and removes it afterwards. Callers cannot
 * tell which happened — which is the point.
 *
 * IMMUTABILITY (WORM). The governance layer depends on an immutability
 * GUARANTEE, never on a vendor. `ObjectClass.IMMUTABLE` means: once
 * written, the bytes at this key are never replaced. Today that is a
 * storage POLICY enforced by refusing overwrite in the active store,
 * while the Evidence Ledger's hash chain is what actually DETECTS
 * tampering — policy prevents ordinary replacement; the ledger proves
 * integrity. A future deployment can add infrastructure-enforced
 * retention (Azure Blob immutability policies, S3 Object Lock in
 * compliance mode), which is STRONGER than the local policy: local
 * write-once is not compliance-mode WORM and this codebase does not
 * claim it is.
 *
 * NOT IMPLEMENTED HERE, DELIBERATELY: no Azure, S3 or network adapter.
 * An adapter with no credentials, no configuration and no caller is
 * decoration, not portability. docs/CLOUD_PORTABILITY.md records the
 * mapping each future adapter must satisfy. (A Memory store exists as a
 * TEST DOUBLE ONLY — see memoryObjectStore.ts — to prove callers do not
 * secretly depend on the filesystem.)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Readable } from "node:stream";
import { createHash, randomUUID } from "node:crypto";
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
 * The contract a storage backend must satisfy.
 *
 * Kept deliberately small: every method has a real caller or a real
 * migration reason, and a future AzureBlobObjectStore / S3ObjectStore has
 * to implement exactly this and nothing more. Nothing here presumes a
 * filesystem — that is what makes the claim "remote storage is an
 * adapter" honest.
 */
export interface ObjectStore {
  readonly kind: string;
  exists(key: string): Promise<boolean>;
  get(key: string): Promise<Buffer | null>;
  metadata(key: string): Promise<ObjectMetadata | null>;
  /** True when the stored bytes still hash to `expectedSha256`. */
  verifyHash(key: string, expectedSha256: string): Promise<boolean>;
  /** Generic Readable — never an fs.ReadStream in the contract. */
  openReadStream(key: string): Promise<Readable | null>;
  /** Write-once for IMMUTABLE: refuses to replace an existing object. */
  put(key: string, body: Buffer, objectClass: ObjectClass): Promise<ObjectMetadata>;
  /**
   * Run `fn` with a host-filesystem path to the object's bytes, for the
   * few operations that require a real file (ZIP assembly, PDF tooling).
   * The path is valid ONLY during the callback; any temporary copy is
   * removed afterwards. Rejects if the object does not exist.
   */
  withLocalFile<T>(key: string, fn: (filePath: string) => Promise<T>): Promise<T>;
}

/**
 * Keys are relative, POSIX-style and rooted at the data directory:
 * `worm/<file>`, `uploads/<file>`, `reports/<file>`,
 * `audit-packages/<id>/<file>`.
 *
 * Served evidence paths (`/worm/<file>`) and bare filenames both appear
 * in existing records, so normalisation accepts them and produces the
 * canonical key. This is the only place that mapping is expressed.
 *
 * Security: a logical key never contains `..` — including encoded and
 * backslash-disguised forms, which are decoded/normalised BEFORE the
 * check so they cannot smuggle a traversal past it.
 */
export function normalizeKey(reference: string, defaultPrefix?: string): string | null {
  if (!reference) return null;
  let ref = reference;
  // Percent-encoded traversal ("%2e%2e%2f") must not survive to the
  // filesystem layer looking innocent. Decode defensively; a reference
  // that fails decoding is rejected rather than passed through raw.
  if (ref.includes("%")) {
    try {
      ref = decodeURIComponent(ref);
    } catch {
      return null;
    }
  }
  ref = ref.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!ref.includes("/") && defaultPrefix) ref = `${defaultPrefix}/${ref}`;
  const segments = ref.split("/");
  // Reject traversal and degenerate segments outright rather than
  // resolving and hoping: a logical name never contains "." or "..".
  if (segments.some((seg) => seg === ".." || seg === "." || seg === "")) return null;
  return ref || null;
}

class LocalObjectStore implements ObjectStore {
  readonly kind = "local-filesystem";

  /**
   * The one place a logical key becomes a physical location — private to
   * this adapter; nothing outside the storage layer sees a path except
   * through withLocalFile's scoped lease. `demo-evidence` is the single
   * exception root — bundled read-only demonstration media shipped inside
   * the image, not tenant data, served from `public/`.
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

  async exists(key: string): Promise<boolean> {
    const p = this.resolve(key);
    if (!p) return false;
    try {
      return (await fs.promises.stat(p)).isFile();
    } catch {
      return false;
    }
  }

  async get(key: string): Promise<Buffer | null> {
    const p = this.resolve(key);
    if (!p) return null;
    try {
      return await fs.promises.readFile(p);
    } catch {
      return null;
    }
  }

  async metadata(key: string): Promise<ObjectMetadata | null> {
    const p = this.resolve(key);
    if (!p) return null;
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile()) return null;
      const body = await fs.promises.readFile(p);
      return {
        key: normalizeKey(key)!,
        size: st.size,
        modifiedAt: new Date(st.mtimeMs).toISOString(),
        sha256: createHash("sha256").update(body).digest("hex"),
      };
    } catch {
      return null;
    }
  }

  async verifyHash(key: string, expectedSha256: string): Promise<boolean> {
    const meta = await this.metadata(key);
    return meta !== null && hashesEqual(meta.sha256, expectedSha256);
  }

  async openReadStream(key: string): Promise<Readable | null> {
    const p = this.resolve(key);
    if (!p || !(await this.exists(key))) return null;
    return fs.createReadStream(p);
  }

  async put(key: string, body: Buffer, objectClass: ObjectClass): Promise<ObjectMetadata> {
    const p = this.resolve(key);
    if (!p) throw new Error(`Invalid object key: ${key}`);
    if (objectClass === ObjectClass.IMMUTABLE && fs.existsSync(p)) {
      // The write-once policy, enforced rather than assumed. A future
      // immutable-blob adapter maps this refusal onto a retention policy.
      throw new Error(`Immutable object already exists and cannot be replaced: ${key}`);
    }
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    await fs.promises.writeFile(p, body);
    return (await this.metadata(key))!;
  }

  async withLocalFile<T>(key: string, fn: (filePath: string) => Promise<T>): Promise<T> {
    const p = this.resolve(key);
    if (!p || !(await this.exists(key))) {
      throw new Error(`Object not found: ${key}`);
    }
    // The local store lends its original file — no copy, no cleanup, and
    // the caller cannot tell this from a remote store's temporary copy.
    return fn(p);
  }
}

/** Length-checked, constant-time-ish hex digest comparison. */
export function hashesEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/**
 * Materialize helper for stores that have no host file to lend: download
 * the bytes to a private temporary file, run the callback, remove the
 * file. Shared so every non-filesystem adapter (including the test
 * double) gets identical, correct cleanup semantics.
 */
export async function materializeToTemp<T>(
  key: string,
  bytes: Buffer,
  fn: (filePath: string) => Promise<T>
): Promise<T> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "obv-object-"));
  const file = path.join(dir, path.basename(normalizeKey(key) ?? randomUUID()));
  await fs.promises.writeFile(file, bytes);
  try {
    return await fn(file);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/**
 * The active store, exposed AS THE INTERFACE: whoever imports this
 * compiles against the provider-neutral contract, so nothing local-only
 * (like the class's private path resolution) can leak through it.
 *
 * Honest scope: swapping this binding moves the callers that use it —
 * today the audit-package evidence flows. Most artifact flows still reach
 * the filesystem directly and must be converted BEFORE an adapter swap
 * changes where their bytes live; docs/CLOUD_PORTABILITY.md §5 tracks
 * that list.
 */
export const objectStore: ObjectStore = new LocalObjectStore();

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
