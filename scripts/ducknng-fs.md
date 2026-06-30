# A content-addressed FS as SQL-over-ducknng + CAS — evidence

`scripts/ducknng-fs.mjs` is a **dogfood** (ridiculous-but-cool): a POSIX-shaped distributed file system built as a
**composition of existing, tested primitives** — no new substrate. Same split as
[Latch Data](https://blog.latch.bio/p/latch-data-a-distributed-file-system) (Postgres metadata + S3 bytes + FUSE):

| Latch Data | here |
|---|---|
| Postgres metadata tree | a DuckDB `fs_node` table **served over ducknng RPC** (mutable cross-process) |
| S3/GCP object bytes | **CAS-of-bytes** (content-addressed) |
| FUSE + GraphQL sync | a FUSE host-port (**unbuilt** — the one new piece) |

`mkdir`/`write`/`read`/`ls -R`/`mv`/`rm` are each a SQL statement RPC'd to the metadata server (+ CAS for bytes):
`mkdir`/`mv`/`rm` are `INSERT`/`UPDATE`/`DELETE` (the writes quack can't do); `ls -R` is a recursive CTE; bytes are
content-addressed. **Dedup, snapshots, and provenance fall out for free.**

Run: `npm run build && node scripts/ducknng-fs.mjs`

## Recorded run (2026-06-30)

```
# after mkdir + 3 writes  (ls -R / = a recursive CTE over the ducknng-served tree)
  d /data
  - /data/a.txt            5b sha256:2cf24dba5fb0…
  - /data/c.txt            5b sha256:486ea46224d1…
  d /data/sub
  - /data/sub/b.txt        5b sha256:2cf24dba5fb0…

  CAS objects: 2  (3 files, 2 distinct contents -> DEDUP)
  read /data/sub/b.txt -> "hello"

# after mv /data/c.txt -> /data/sub/c.txt   (mv = UPDATE over RPC)
  d /data
  - /data/a.txt            5b sha256:2cf24dba5fb0…
  d /data/sub
  - /data/sub/b.txt        5b sha256:2cf24dba5fb0…
  - /data/sub/c.txt        5b sha256:486ea46224d1…

# after rm -r /data/sub   (rm -r = recursive DELETE over RPC)
  d /data
  - /data/a.txt            5b sha256:2cf24dba5fb0…
```

**What it proves:** `a.txt` and `sub/b.txt` (both `"hello"`) share one digest → **2 CAS objects for 3 files** (dedup).
The directory tree is mutated in place over ducknng RPC (`mkdir`/`mv`/`rm` = `INSERT`/`UPDATE`/`DELETE`), and `ls -R`
is a recursive CTE over the served tree. The two *hard* pieces (a mutable metadata graph over RPC + content-
addressed bytes) were already built and tested — so a distributed FS is a **composition**, with dedup/versioning/
provenance/`du` for free. FUSE (a host-port like the ProcessRunner) would make it actually mountable.
