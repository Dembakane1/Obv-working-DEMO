/**
 * WormEvidenceStore — write-once-read-many evidence storage plus the
 * append-only, hash-chained evidence ledger.
 *
 * TODO: production implementation using Azure Blob Storage immutability
 *       policy / legal hold (time-based retention on the evidence container,
 *       ledger anchoring via Azure Confidential Ledger or equivalent).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { WORM_DIR } from "../db/index";
import * as repo from "../db/repo";
import type { LedgerEntry } from "../../shared/types";

export interface StoredObject {
  /** URL path the object is served from. */
  path: string;
  /** sha256 hex digest of the object bytes. */
  hash: string;
}

export interface LedgerAppendInput {
  evidenceItemId: string;
  milestoneId: string;
  verificationId: string;
  /** Hash of the underlying evidence payload (photo bytes + metadata). */
  payloadHash: string;
  timestamp?: string;
}

export interface WormEvidenceStore {
  /** Persist evidence bytes immutably. Rejects overwrites. */
  storeObject(bytes: Buffer, extension: string): Promise<StoredObject>;
  /** Append a hash-chained entry to the evidence ledger. */
  appendLedgerEntry(input: LedgerAppendInput): Promise<LedgerEntry>;
  /** Walk the chain and recompute every hash. */
  verifyChain(): Promise<{ valid: boolean; entries: number; brokenAt?: number }>;
}

/** Predefined genesis value for the first entry's previous_hash. */
export const GENESIS_HASH = sha256("OBV-LEDGER-GENESIS-v1");

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Derives an entry's current hash from the ledger content plus the
 * previous entry's hash. This exact function is also used by
 * verifyChain(), so any mutation of a stored row is detectable.
 */
export function computeEntryHash(
  entry: Pick<
    LedgerEntry,
    "seq" | "evidenceItemId" | "milestoneId" | "verificationId" | "timestamp" | "payloadHash"
  >,
  previousHash: string
): string {
  const content = JSON.stringify({
    seq: entry.seq,
    evidenceItemId: entry.evidenceItemId,
    milestoneId: entry.milestoneId,
    verificationId: entry.verificationId,
    timestamp: entry.timestamp,
    payloadHash: entry.payloadHash,
  });
  return sha256(content + previousHash);
}

/**
 * Local mock: evidence bytes go to data/worm/ (content-addressed, never
 * overwritten) and the ledger lives in the ledger_entries table
 * (append-only by convention and by hash chain).
 */
export class LocalWormEvidenceStore implements WormEvidenceStore {
  async storeObject(bytes: Buffer, extension: string): Promise<StoredObject> {
    const hash = sha256(bytes);
    const fileName = `${hash}.${extension.replace(/^\./, "")}`;
    const filePath = path.join(WORM_DIR, fileName);
    if (!fs.existsSync(filePath)) {
      // WORM semantics: create-only, never truncate an existing object.
      fs.writeFileSync(filePath, bytes, { flag: "wx" });
    }
    return { path: `/worm/${fileName}`, hash };
  }

  async appendLedgerEntry(input: LedgerAppendInput): Promise<LedgerEntry> {
    const previous = repo.lastLedgerEntry();
    const previousHash = previous ? previous.currentHash : GENESIS_HASH;
    const seq = previous ? previous.seq + 1 : 1;
    const timestamp = input.timestamp ?? new Date().toISOString();
    const draft = {
      seq,
      evidenceItemId: input.evidenceItemId,
      milestoneId: input.milestoneId,
      verificationId: input.verificationId,
      timestamp,
      payloadHash: input.payloadHash,
    };
    const entry: LedgerEntry = {
      id: repo.newId(),
      ...draft,
      previousHash,
      currentHash: computeEntryHash(draft, previousHash),
    };
    repo.insertLedgerEntry(entry);
    return entry;
  }

  async verifyChain(): Promise<{ valid: boolean; entries: number; brokenAt?: number }> {
    const entries = repo.listLedgerEntries();
    let previousHash = GENESIS_HASH;
    for (const entry of entries) {
      const expected = computeEntryHash(entry, previousHash);
      if (entry.previousHash !== previousHash || entry.currentHash !== expected) {
        return { valid: false, entries: entries.length, brokenAt: entry.seq };
      }
      previousHash = entry.currentHash;
    }
    return { valid: true, entries: entries.length };
  }
}

export const wormEvidenceStore: WormEvidenceStore = new LocalWormEvidenceStore();
