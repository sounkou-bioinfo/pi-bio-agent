import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";

// DOGFOOD (ridiculous-but-cool): a content-addressed distributed FILE SYSTEM as a COMPOSITION of pieces we
// already have — the metadata tree is a DuckDB table served over ducknng RPC (mutable cross-process: mkdir/
// rename/rm are UPDATE/DELETE — the writes quack can't do), and the bytes live in CAS (content-addressed ->
// dedup + versioning for free). Same split as Latch Data (Postgres metadata + S3 bytes + FUSE), but: dedup,
// snapshots, provenance, and `ls -R`/`du` come FREE (CAS + a recursive CTE). The only unbuilt piece is a FUSE
// host-port; the FS *semantics* are demonstrated here as SQL over ducknng + CAS. No new substrate — composition.
//
// Run:  npm run build && node scripts/ducknng-fs.mjs

const CAS = join(tmpdir(), `ducknng-fs-cas-${process.pid}`);
const esc = (s) => String(s).replace(/'/g, "''");

// --- CAS: write-once content store (the "object bytes" layer) ---
async function casPut(buf) {
  const digest = "sha256:" + createHash("sha256").update(buf).digest("hex");
  await fs.mkdir(CAS, { recursive: true });
  const p = join(CAS, digest.replace(":", "_"));
  if (!(await fs.access(p).then(() => true).catch(() => false))) await fs.writeFile(p, buf);
  return { digest, size: buf.length };
}
const casGet = (digest) => fs.readFile(join(CAS, digest.replace(":", "_")));
const casCount = async () => (await fs.readdir(CAS).catch(() => [])).length;

async function main() {
  // --- metadata server: a ducknng-served DuckDB owns the directory tree ---
  const sInst = await DuckDBInstance.create(":memory:");
  const S = await sInst.connect();
  await S.run("LOAD ducknng");
  await S.run("CREATE SEQUENCE fs_seq START 2");
  await S.run("CREATE TABLE fs_node (id BIGINT PRIMARY KEY, parent_id BIGINT, name TEXT, kind TEXT, digest TEXT, size BIGINT)");
  await S.run("INSERT INTO fs_node VALUES (1, NULL, '/', 'dir', NULL, NULL)"); // root inode
  await S.run("SELECT ducknng_start_server('fs', 'tcp://127.0.0.1:0', 2, 134217728, 300000, 0::UBIGINT)");
  await S.run("SELECT ducknng_register_exec_method(false)"); // exec opt-in = the host boundary
  const url = String((await S.runAndReadAll("SELECT listen FROM ducknng_list_servers() WHERE name='fs'")).getRows()[0][0]);

  // --- a client: every FS op is a SQL statement RPC'd to the metadata server (+ CAS for bytes) ---
  const cInst = await DuckDBInstance.create(":memory:");
  const C = await cInst.connect();
  await C.run("LOAD ducknng");
  const exec = (sql) => C.runAndReadAll(`SELECT * FROM ducknng_run_rpc('${url}', ?, 0::UBIGINT)`, [sql]);
  const query = async (sql) => (await C.runAndReadAll(`SELECT * FROM ducknng_query_rpc('${url}', ?, 0::UBIGINT)`, [sql])).getRowObjects();

  const splitp = (path) => { const parts = path.split("/").filter(Boolean); return { parts, parent: "/" + parts.slice(0, -1).join("/"), name: parts.at(-1) }; };
  const resolve = async (path) => {
    let id = 1;
    for (const part of path.split("/").filter(Boolean)) {
      const r = await query(`SELECT id FROM fs_node WHERE parent_id=${id} AND name='${esc(part)}'`);
      if (!r.length) throw new Error(`no such path: ${path} (at '${part}')`);
      id = Number(r[0].id);
    }
    return id;
  };
  const mkdir = async (path) => { const { parent, name } = splitp(path); const pid = await resolve(parent); await exec(`INSERT INTO fs_node SELECT nextval('fs_seq'), ${pid}, '${esc(name)}', 'dir', NULL, NULL`); };
  const writeFile = async (path, content) => {
    const { digest, size } = await casPut(Buffer.from(content));
    const { parent, name } = splitp(path); const pid = await resolve(parent);
    await exec(`DELETE FROM fs_node WHERE parent_id=${pid} AND name='${esc(name)}'`); // upsert
    await exec(`INSERT INTO fs_node SELECT nextval('fs_seq'), ${pid}, '${esc(name)}', 'file', '${digest}', ${size}`);
  };
  const readFile = async (path) => { const id = await resolve(path); const r = await query(`SELECT digest FROM fs_node WHERE id=${id}`); return (await casGet(r[0].digest)).toString(); };
  const mv = async (src, dst) => { const sid = await resolve(src); const { parent, name } = splitp(dst); const pid = await resolve(parent); await exec(`UPDATE fs_node SET parent_id=${pid}, name='${esc(name)}' WHERE id=${sid}`); };
  const rmR = async (path) => { const id = await resolve(path); await exec(`DELETE FROM fs_node WHERE id IN (WITH RECURSIVE sub(id) AS (SELECT ${id} UNION ALL SELECT n.id FROM fs_node n JOIN sub s ON n.parent_id=s.id) SELECT id FROM sub)`); };
  const lsR = async (path) => {
    const rootId = await resolve(path);
    return query(`WITH RECURSIVE walk(id, p, kind, digest, size) AS (
        SELECT id, '', kind, digest, size FROM fs_node WHERE id=${rootId}
        UNION ALL SELECT n.id, w.p||'/'||n.name, n.kind, n.digest, n.size FROM fs_node n JOIN walk w ON n.parent_id=w.id)
      SELECT p AS path, kind, coalesce(digest,'') AS digest, coalesce(size,0) AS size FROM walk WHERE id<>${rootId} ORDER BY path`);
  };

  const tree = async (label) => {
    console.log(`\n# ${label}  (ls -R / = a recursive CTE over the ducknng-served tree)`);
    for (const r of await lsR("/")) console.log(`  ${r.kind === "dir" ? "d" : "-"} ${String(r.path).padEnd(22)} ${r.kind === "file" ? `${Number(r.size)}b ${String(r.digest).slice(0, 19)}…` : ""}`);
  };

  console.log("=== A content-addressed distributed FS as SQL-over-ducknng + CAS (no FUSE; semantics only) ===");
  await mkdir("/data"); await mkdir("/data/sub");
  await writeFile("/data/a.txt", "hello");          // content "hello"
  await writeFile("/data/sub/b.txt", "hello");       // SAME content -> dedup in CAS
  await writeFile("/data/c.txt", "world");           // different content
  await tree("after mkdir + 3 writes");
  console.log(`\n  CAS objects: ${await casCount()}  (3 files, 2 distinct contents -> DEDUP)`);
  console.log(`  read /data/sub/b.txt -> "${await readFile("/data/sub/b.txt")}"`);
  await mv("/data/c.txt", "/data/sub/c.txt");        // rename = UPDATE over RPC (quack can't)
  await tree("after mv /data/c.txt -> /data/sub/c.txt");
  await rmR("/data/sub");                             // rm -r = recursive DELETE over RPC
  await tree("after rm -r /data/sub");

  console.log("\nWhat it proves: a POSIX-shaped FS (mkdir/write/read/ls -R/mv/rm) is the COMPOSITION of a ducknng-");
  console.log("served mutable metadata tree (mkdir/mv/rm = INSERT/UPDATE/DELETE over RPC) + CAS bytes. Dedup,");
  console.log("recursive listing (a CTE), and provenance fall out for free — the two hard pieces (mutable graph +");
  console.log("content-addressed bytes) were already built and tested. FUSE would be the one new host-port.");
  await S.run("SELECT ducknng_stop_server('fs')");
  C.closeSync(); cInst.closeSync(); S.closeSync(); sInst.closeSync();
  await fs.rm(CAS, { recursive: true, force: true });
}
main().catch((e) => { console.error(e); process.exit(1); });
