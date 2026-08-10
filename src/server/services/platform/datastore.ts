/**
 * Data store posture — what the active database engine can and cannot do.
 *
 * WHY THIS FILE EXISTS: OBV's pilot runs on SQLite over a mounted volume.
 * That is a correct, durable, well-understood choice for one instance —
 * and a silent corruption risk for two. Nothing in the codebase used to
 * SAY so, which meant the constraint lived only in an operator's memory:
 * scaling the service to two replicas on any platform would have put two
 * writers on one database file with no error, no warning, and no obvious
 * symptom until the damage was already recorded.
 *
 * So the constraint is now a first-class, disclosed property of the
 * deployment. It appears in the startup log, in the readiness payload and
 * in `pilot:check`, and it is asserted by the cloud-portability suite.
 *
 * This module deliberately does NOT implement distributed locking. There
 * is no safe way to make one SQLite file serve multiple application
 * instances across a network, and pretending otherwise would be worse
 * than the honest constraint. The path to multiple writers is PostgreSQL
 * — see docs/POSTGRES_MIGRATION_MAP.md.
 */

export type DataStoreEngine = "sqlite";

export interface DataStorePosture {
  engine: DataStoreEngine;
  /**
   * How many application instances may WRITE to this store concurrently.
   * One, for SQLite over a shared volume. A future PostgreSQL data store
   * reports many, which is the entire point of migrating.
   */
  maxWriterInstances: number;
  /** True when the engine tolerates horizontal scaling of the app tier. */
  supportsHorizontalScale: boolean;
  /** Operator-facing explanation of the constraint. */
  constraint: string;
}

export function dataStorePosture(): DataStorePosture {
  return {
    engine: "sqlite",
    maxWriterInstances: 1,
    supportsHorizontalScale: false,
    constraint:
      "SQLite over a mounted volume serves EXACTLY ONE application instance. " +
      "Do not scale this service beyond one replica and do not point a second " +
      "deployment at the same data directory: OBV performs no cross-instance " +
      "locking, so concurrent writers can corrupt the database silently. " +
      "Multi-instance operation requires migrating the data store to PostgreSQL.",
  };
}

/** Operator-facing boot disclosure. Contains no secrets and no paths. */
export function dataStoreStartupNotice(): string {
  const p = dataStorePosture();
  return (
    `Data store: engine=${p.engine} · max writer instances=${p.maxWriterInstances} · ` +
    `horizontal scale=${p.supportsHorizontalScale ? "supported" : "NOT SUPPORTED"} — ` +
    `run exactly one instance against this data directory.`
  );
}
