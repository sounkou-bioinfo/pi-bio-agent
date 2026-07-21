import {
  DuckDBInstance,
  DuckDBInstanceCache,
  version as duckdbRuntimeVersion,
  type DuckDBConnection,
  type DuckDBPreparedStatement,
  type DuckDBType,
  type DuckDBValue,
  type DuckDBValueConverter,
  arrayFromArrayValue,
  arrayFromListValue,
  bigintFromBigIntValue,
  booleanFromValue,
  createDuckDBValueConverter,
  DuckDBTypeId,
  nullConverter,
  numberFromValue,
  objectArrayFromMapValue,
  objectFromIntervalValue,
  objectFromStructValue,
  objectFromUnionValue,
  stringFromValue,
  bytesFromBitValue,
  bytesFromBlobValue,
  DuckDBTimestampTZValue,
  DuckDBTimestampValue,
  BIGINT,
  BLOB,
  BOOLEAN,
  DOUBLE,
  HUGEINT,
  LIST,
  SQLNULL,
  STRUCT,
  VARCHAR,
  blobValue,
  listValue,
  structValue,
} from "@duckdb/node-api";
import { createRequire } from "node:module";
import { readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type { SqlConn, SqlValue } from "../core/ports.js";

type DuckDbFileOwner = { mode: "shared"; handles: number } | { mode: "exclusive" };

interface ProcessDuckDbState {
  nodeApiPackageVersion: string;
  instanceCache: DuckDBInstanceCache;
  initializationTails: Map<string, Promise<void>>;
  exclusiveTails: Map<string, Promise<void>>;
  fileIdentityPaths: Map<string, string>;
  fileOwners: Map<string, DuckDbFileOwner>;
}

const PROCESS_DUCKDB_STATE = Symbol.for("pi-bio-agent.duckdb-process-state.v1");
const duckdbNodeApiPackageVersion = (createRequire(import.meta.url)("@duckdb/node-api/package.json") as { version: string }).version;

function duckdbCoreVersion(version: string): string | undefined {
  return /^v?(\d+\.\d+\.\d+)/.exec(version)?.[1];
}

/** Fail before opening a database when another Pi package has interposed an incompatible libduckdb.so.
 *
 * Linux resolves the first process-loaded `libduckdb.so` SONAME for every later `duckdb.node` addon, even when
 * the addons came from different package-local node_modules trees. A node-api 1.5.2 addon can therefore call a
 * 1.5.4 library. That is an ABI mismatch, not a supported DuckDB upgrade path, and must fail before touching a
 * persistent store instead of surfacing later as allocator assertions or a corrupted database.
 */
export function assertDuckDbNativeCompatibility(
  packageVersion = duckdbNodeApiPackageVersion,
  runtimeVersion = duckdbRuntimeVersion(),
): void {
  const expected = duckdbCoreVersion(packageVersion);
  const loaded = duckdbCoreVersion(runtimeVersion);
  if (!expected || !loaded || expected !== loaded) {
    throw new Error(
      `DuckDB native-library mismatch: @duckdb/node-api ${packageVersion} is executing against ${runtimeVersion}. ` +
      "Pi packages in one process must use the same @duckdb/node-api version; align dependencies and restart Pi before opening a DuckDB database.",
    );
  }
}

function processDuckDbState(): ProcessDuckDbState {
  assertDuckDbNativeCompatibility();
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const existing = globals[PROCESS_DUCKDB_STATE] as ProcessDuckDbState | undefined;
  if (existing) {
    if (existing.nodeApiPackageVersion !== duckdbNodeApiPackageVersion) {
      throw new Error(
        `Multiple pi-bio-agent copies loaded incompatible @duckdb/node-api packages in one process ` +
        `(${existing.nodeApiPackageVersion} and ${duckdbNodeApiPackageVersion}); align dependencies and restart Pi.`,
      );
    }
    return existing;
  }
  const created: ProcessDuckDbState = {
    nodeApiPackageVersion: duckdbNodeApiPackageVersion,
    instanceCache: new DuckDBInstanceCache(),
    initializationTails: new Map(),
    exclusiveTails: new Map(),
    fileIdentityPaths: new Map(),
    fileOwners: new Map(),
  };
  globals[PROCESS_DUCKDB_STATE] = created;
  return created;
}

async function canonicalFilePath(path: string, seen: Set<string> = new Set()): Promise<string> {
  const absolute = resolve(path);
  if (seen.has(absolute)) return absolute;
  seen.add(absolute);
  try {
    return await realpath(absolute);
  } catch {
    // realpath fails for a dangling file symlink even though its target identity is knowable. Follow that target
    // explicitly so two pre-creation aliases cannot evade the cache/separation key. readlink on a non-symlink fails.
    try {
      const target = await readlink(absolute);
      return canonicalFilePath(resolve(dirname(absolute), target), seen);
    } catch {
      // A first opener creates the database file, so ordinary targets may not exist yet. Canonicalize the nearest
      // existing ancestor recursively; this also collapses aliases through a symlinked project directory.
      const parent = dirname(absolute);
      return parent === absolute ? absolute : join(await canonicalFilePath(parent, seen), basename(absolute));
    }
  }
}

async function fileIdentity(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.dev}:${info.ino}`;
  } catch {
    return undefined;
  }
}

async function canonicalCachePath(state: ProcessDuckDbState, path: string): Promise<string> {
  const canonical = await canonicalFilePath(path);
  const identity = await fileIdentity(canonical);
  if (!identity) return canonical;
  const known = state.fileIdentityPaths.get(identity);
  if (known && await fileIdentity(known) === identity) return known;
  state.fileIdentityPaths.set(identity, canonical);
  return canonical;
}

/** True when two file-backed DuckDB paths resolve to the same path or existing filesystem object. */
export async function duckDbPathsReferToSameFile(a: string, b: string): Promise<boolean> {
  if (a === ":memory:" || b === ":memory:") return a === b;
  const [left, right] = await Promise.all([canonicalFilePath(a), canonicalFilePath(b)]);
  if (left === right) return true;
  const [leftIdentity, rightIdentity] = await Promise.all([fileIdentity(left), fileIdentity(right)]);
  return leftIdentity !== undefined && leftIdentity === rightIdentity;
}

/** Open an isolated in-memory instance or a process-cached file instance.
 *
 * DuckDB explicitly forbids attaching one database file through multiple instances in a process. File-backed
 * callers therefore share one native instance cache while retaining independent connections. Symlink and existing
 * hard-link aliases collapse to one cache key. `:memory:` remains isolated per call so unrelated scientific runs
 * cannot see each other's temporary state.
 */
export async function openDuckDbInstance(path: string, options?: Record<string, string>): Promise<DuckDBInstance> {
  const state = processDuckDbState();
  if (path === ":memory:") return DuckDBInstance.create(path, options);
  const key = await canonicalCachePath(state, path);
  const owner = state.fileOwners.get(key);
  if (owner?.mode === "exclusive") {
    throw new Error(`DuckDB file '${key}' already has an active isolated scientific owner; a cached shared instance cannot overlap it`);
  }
  state.fileOwners.set(key, { mode: "shared", handles: (owner?.handles ?? 0) + 1 });
  let instance: DuckDBInstance;
  try {
    instance = await state.instanceCache.getOrCreateInstance(key, options);
  } catch (error) {
    releaseSharedFileOwner(state, key);
    throw error;
  }
  // A first open may have created a previously absent file. Register its identity now so a later hard-link alias
  // resolves back to this native cache key rather than attaching the inode through another instance.
  const identity = await fileIdentity(key);
  if (identity) state.fileIdentityPaths.set(identity, key);
  const nativeClose = instance.closeSync.bind(instance);
  let closed = false;
  instance.closeSync = () => {
    if (closed) return;
    closed = true;
    try {
      nativeClose();
    } finally {
      releaseSharedFileOwner(state, key);
    }
  };
  return instance;
}

function releaseSharedFileOwner(state: ProcessDuckDbState, key: string): void {
  const owner = state.fileOwners.get(key);
  if (owner?.mode !== "shared") return;
  if (owner.handles === 1) state.fileOwners.delete(key);
  else state.fileOwners.set(key, { mode: "shared", handles: owner.handles - 1 });
}

/** Serialize idempotent schema/bootstrap DDL for connections sharing one cached file instance.
 *
 * DuckDB permits concurrent connections to a shared instance, but concurrent `CREATE ... IF NOT EXISTS` statements
 * can still conflict in the catalog. This lock covers initialization only; normal append/query work remains
 * concurrent on separate connections.
 */
async function withDuckDbPathLock<T>(
  tails: Map<string, Promise<void>>,
  key: string,
  body: () => Promise<T>,
): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((done) => { release = done; });
  const tail = previous.catch(() => undefined).then(() => gate);
  tails.set(key, tail);
  await previous.catch(() => undefined);
  try {
    return await body();
  } finally {
    release();
    if (tails.get(key) === tail) tails.delete(key);
  }
}

export async function withDuckDbFileInitialization<T>(path: string, initialize: () => Promise<T>): Promise<T> {
  if (path === ":memory:") return initialize();
  const state = processDuckDbState();
  const key = await canonicalCachePath(state, path);
  return withDuckDbPathLock(state.initializationTails, key, initialize);
}

/** Run one isolated file-backed scientific database owner at a time for a path.
 *
 * Scientific runs may load different native extensions and therefore create/close their own DuckDB instance rather
 * than retaining the ledger's shared instance. This process-wide lane prevents two such instances from attaching
 * one file concurrently. In-memory runs remain independent and concurrent.
 */
export async function withDuckDbFileExclusive<T>(path: string, run: () => Promise<T>): Promise<T> {
  if (path === ":memory:") return run();
  const state = processDuckDbState();
  const key = await canonicalCachePath(state, path);
  return withDuckDbPathLock(state.exclusiveTails, key, async () => {
    const owner = state.fileOwners.get(key);
    if (owner) {
      throw new Error(
        owner.mode === "shared"
          ? `DuckDB file '${key}' already has ${owner.handles} active cached shared handle(s); an isolated scientific owner cannot overlap them`
          : `DuckDB file '${key}' already has an active isolated scientific owner`,
      );
    }
    state.fileOwners.set(key, { mode: "exclusive" });
    try {
      return await run();
    } finally {
      if (state.fileOwners.get(key)?.mode === "exclusive") state.fileOwners.delete(key);
    }
  });
}

const unsupportedPortableConversion: DuckDBValueConverter<SqlValue> = (_value, type) => {
  throw new Error(`Unsupported DuckDB value type for SQL transport: ${type.typeId} (${type.toString()})`);
};

const canonicalTimestampTzValue: DuckDBValueConverter<SqlValue> = (value, type) => {
  if (value instanceof DuckDBTimestampTZValue) {
    if (value.isFinite) {
      return `${new DuckDBTimestampValue(value.micros).toString()}+00`;
    }
    return value.toString();
  }
  throw new Error(`Expected DuckDBTimestampTZValue for type ${type}`);
};

const portableSqlValueConverter = createDuckDBValueConverter<SqlValue>({
  [DuckDBTypeId.INVALID]: unsupportedPortableConversion,
  [DuckDBTypeId.BOOLEAN]: booleanFromValue,
  [DuckDBTypeId.TINYINT]: numberFromValue,
  [DuckDBTypeId.SMALLINT]: numberFromValue,
  [DuckDBTypeId.INTEGER]: numberFromValue,
  [DuckDBTypeId.BIGINT]: bigintFromBigIntValue,
  [DuckDBTypeId.UTINYINT]: numberFromValue,
  [DuckDBTypeId.USMALLINT]: numberFromValue,
  [DuckDBTypeId.UINTEGER]: numberFromValue,
  [DuckDBTypeId.UBIGINT]: bigintFromBigIntValue,
  [DuckDBTypeId.FLOAT]: numberFromValue,
  [DuckDBTypeId.DOUBLE]: numberFromValue,
  [DuckDBTypeId.TIMESTAMP]: stringFromValue,
  [DuckDBTypeId.DATE]: stringFromValue,
  [DuckDBTypeId.TIME]: stringFromValue,
  [DuckDBTypeId.INTERVAL]: objectFromIntervalValue,
  [DuckDBTypeId.HUGEINT]: bigintFromBigIntValue,
  [DuckDBTypeId.UHUGEINT]: bigintFromBigIntValue,
  [DuckDBTypeId.VARCHAR]: stringFromValue,
  [DuckDBTypeId.BLOB]: bytesFromBlobValue,
  [DuckDBTypeId.DECIMAL]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP_S]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP_MS]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP_NS]: stringFromValue,
  [DuckDBTypeId.ENUM]: stringFromValue,
  [DuckDBTypeId.LIST]: arrayFromListValue,
  [DuckDBTypeId.STRUCT]: objectFromStructValue,
  [DuckDBTypeId.MAP]: objectArrayFromMapValue,
  [DuckDBTypeId.ARRAY]: arrayFromArrayValue,
  [DuckDBTypeId.UUID]: stringFromValue,
  [DuckDBTypeId.UNION]: objectFromUnionValue,
  [DuckDBTypeId.BIT]: bytesFromBitValue,
  [DuckDBTypeId.TIME_TZ]: stringFromValue,
  [DuckDBTypeId.TIMESTAMP_TZ]: canonicalTimestampTzValue,
  [DuckDBTypeId.ANY]: unsupportedPortableConversion,
  [DuckDBTypeId.BIGNUM]: bigintFromBigIntValue,
  [DuckDBTypeId.SQLNULL]: nullConverter,
  [DuckDBTypeId.STRING_LITERAL]: unsupportedPortableConversion,
  [DuckDBTypeId.INTEGER_LITERAL]: unsupportedPortableConversion,
  [DuckDBTypeId.TIME_NS]: stringFromValue,
});

interface PortableDuckDBInput {
  value: DuckDBValue;
  type: DuckDBType;
}

function portableInputValue(value: unknown, seen: Set<object> = new Set(), depth = 0): PortableDuckDBInput {
  if (value === null) return { value: null, type: SQLNULL };
  if (typeof value === "boolean") return { value, type: BOOLEAN };
  if (typeof value === "number") return { value, type: DOUBLE };
  if (typeof value === "string") return { value, type: VARCHAR };
  if (typeof value === "bigint") {
    const type = value >= -9223372036854775808n && value <= 9223372036854775807n ? BIGINT : HUGEINT;
    return { value, type };
  }
  if (value instanceof Uint8Array) return { value: blobValue(value), type: BLOB };
  if (typeof value !== "object") {
    throw new Error("Unsupported SQL parameter value; expected a portable SQL value");
  }
  if (seen.has(value)) throw new Error("SQL parameter values cannot be cyclic");
  if (depth > 16) throw new Error("SQL parameter nesting exceeds 16 levels");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value.map((item) => portableInputValue(item, seen, depth + 1));
      const concreteTypes = [...new Map(
        items.filter((_item, index) => value[index] !== null).map((item) => [item.type.toString(), item.type]),
      ).values()];
      if (concreteTypes.length > 1) {
        throw new Error("SQL list parameters must have one concrete element type");
      }
      const elementType = concreteTypes[0] ?? VARCHAR;
      return { value: listValue(items.map((item) => item.value)), type: LIST(elementType) };
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const rawEntries = Object.entries(value);
      if (rawEntries.length === 0) {
        throw new Error("SQL struct parameters cannot be empty because they have no inferable field types");
      }
      const entries = rawEntries.map(([key, item]) => [key, portableInputValue(item, seen, depth + 1)] as const);
      return {
        value: structValue(Object.fromEntries(entries.map(([key, item]) => [key, item.value]))),
        type: STRUCT(Object.fromEntries(entries.map(([key, item]) => [key, item.type]))),
      };
    }
    throw new Error("Unsupported SQL parameter object; expected an array, byte array, or plain record");
  } finally {
    seen.delete(value);
  }
}

function bindPortableParams(statement: DuckDBPreparedStatement, params: readonly unknown[]): void {
  if (statement.parameterCount !== params.length) {
    throw new Error(
      "SQL parameter count mismatch: statement expects " + statement.parameterCount + ", received " + params.length,
    );
  }
  params.forEach((raw, offset) => {
    const index = offset + 1;
    const input = portableInputValue(raw);
    const expectedId = statement.parameterTypeId(index);
    const numberType =
      expectedId === DuckDBTypeId.TINYINT || expectedId === DuckDBTypeId.SMALLINT ||
      expectedId === DuckDBTypeId.INTEGER || expectedId === DuckDBTypeId.UTINYINT ||
      expectedId === DuckDBTypeId.USMALLINT || expectedId === DuckDBTypeId.UINTEGER ||
      expectedId === DuckDBTypeId.FLOAT || expectedId === DuckDBTypeId.DOUBLE;
    const bigintType =
      expectedId === DuckDBTypeId.BIGINT || expectedId === DuckDBTypeId.HUGEINT ||
      expectedId === DuckDBTypeId.UBIGINT || expectedId === DuckDBTypeId.UHUGEINT ||
      expectedId === DuckDBTypeId.BIGNUM;
    const useExpectedType =
      (typeof raw === "number" && numberType) ||
      (typeof raw === "bigint" && bigintType) ||
      (typeof raw === "boolean" && expectedId === DuckDBTypeId.BOOLEAN) ||
      (typeof raw === "string" && (expectedId === DuckDBTypeId.VARCHAR || expectedId === DuckDBTypeId.ENUM)) ||
      (raw instanceof Uint8Array && expectedId === DuckDBTypeId.BLOB);
    statement.bindValue(index, input.value, useExpectedType ? statement.parameterType(index) : input.type);
  });
}

async function prepareLastStatement(connection: DuckDBConnection, sql: string): Promise<DuckDBPreparedStatement> {
  const extracted = await connection.extractStatements(sql);
  for (let index = 0; index < extracted.count - 1; index += 1) {
    const statement = await extracted.prepare(index);
    try {
      await statement.run();
    } finally {
      statement.destroySync();
    }
  }
  return extracted.prepare(extracted.count - 1);
}

/**
 * Adapt a live `@duckdb/node-api` connection to the `SqlConn` execution port — the one DuckDB adapter, used
 * by the operation runner and the temporal observation/graph store alike. This file's only coupling to the driver is type-level (the
 * host creates and owns the `DuckDBInstance`/connection), so the rest of the package stays driver-agnostic
 * and the adapter logic remains testable through a fake port. Input values use a canonical host-neutral mapping
 * rather than the driver's integer heuristic, so local, HTTP, and ducknng transports bind the same logical types.
 */
export function duckdbNodeConn(connection: DuckDBConnection): SqlConn {
  return {
    async all<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
      if (params.length === 0) {
        const reader = await connection.runAndReadAll(sql);
        return reader.convertRowObjects(portableSqlValueConverter) as T[];
      }
      const statement = await prepareLastStatement(connection, sql);
      try {
        bindPortableParams(statement, params);
        const reader = await statement.runAndReadAll();
        return reader.convertRowObjects(portableSqlValueConverter) as T[];
      } finally {
        statement.destroySync();
      }
    },
    async run(sql: string, params: readonly unknown[] = []): Promise<void> {
      if (params.length === 0) {
        await connection.run(sql);
        return;
      }
      const statement = await prepareLastStatement(connection, sql);
      try {
        bindPortableParams(statement, params);
        await statement.run();
      } finally {
        statement.destroySync();
      }
    },
  };
}
