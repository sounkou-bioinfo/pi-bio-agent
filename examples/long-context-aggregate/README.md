# Example: deterministic reduction over long-context rows

[Recursive Language Models](https://alexzhang13.github.io/blog/2025/rlm/) (RLM; Zhang & Khattab,
[arXiv 2512.24601](https://arxiv.org/abs/2512.24601)) handle unbounded context by storing it as a *variable in a
Python REPL* and recursively sub-querying an LM. On the OOLONG benchmark (`trec_coarse` split — ~3000–6000 rows,
132k–263k tokens) the query is *"among the instances associated with these user IDs, how many are label X?"* where
the labels are the TREC coarse question classes (`number`, `human`, `location`, `description`, `entity`,
`abbreviation`) and, per the blog, *"the model has to infer the labeling to answer."* RLM's *"performance drop …
occurs for counting problems, where it makes more errors when the context length increases."*

In this substrate that question is **one `GROUP BY`.** The rows live as a DuckDB table (`entries`); the agent
never sees the whole context — only the bounded result — so there is no context rot, and the count is exact:

```sql
SELECT label, count(*) AS n
FROM entries
WHERE user_id IN (1, 2, 3)     -- the "these user IDs" subset
GROUP BY label
ORDER BY label
```

DuckDB supplies the external relational environment for inspection and exact reduction. It does not supply RLM's
programmatic recursive model calls:

| RLM (Python REPL over a string var) | here (`bio_query` over a DuckDB table) |
|---|---|
| peek (`ctx[:2000]`) | `SELECT * FROM entries LIMIT 5` |
| grep (regex narrowing) | `WHERE regexp_matches(instance, 'Calypso')` |
| partition + semantic map (recursive LM calls) | host-owned model/agent workers; not implemented by this manifest |
| summarize | SQL aggregates |

## Honest scope: this manifest is the *reduce*, not the whole loop

The blog describes a **"Partition + Map"** strategy: when the model "cannot directly grep or retrieve information
due to some semantic equivalence," it chunks the context and runs recursive LM calls to *infer* each row's label —
the semantic map, the part RLM spends recursive LM calls on. Answering distributionally is then the reduce.
("map-reduce" is our gloss; the blog's own term is "Partition + Map.") The `GROUP BY` above is only the **reduce**,
and it is exact *because the labels already exist* — the `entries` table ships with a `label` column. Since OOLONG
rows arrive **unlabeled** ("the model has to infer the labeling"), claiming "counting beats the model" from this
manifest alone would be overclaiming: it elides the hard, semantic **map**.

The map is shown runnably, not asserted:

- **`scripts/rlm-map-reduce.mjs`** (`npm run build && node scripts/rlm-map-reduce.mjs`) — a map/reduce process skeleton
  **processes**: a supervisor splits an *unlabeled* context into partitions and fans them out to worker
  **processes**, each labeling its slice in its **own `:memory:` DuckDB SQL REPL** (the semantic map — a `CASE`
  rule stands in for the LM so it is deterministic and testable); the workers write nothing shared; the **host is
  the single writer** that merges the label artifacts; only then is the distributional query the deterministic
  `GROUP BY`. This is why concurrent map workers never contend for DuckDB's process-exclusive write lock.
- **`test/map-reduce-labeling.test.ts`** — the same partition → parallel-label → host-merge → aggregate shape,
  in-process, asserting the exact counts.

So: the *semantic* labeling is the judgment boundary (an LM in a real RLM-style host; a rule in these patterns);
everything **distributional** is deterministic SQL. This example proves the exact reduce after labels exist. It
does not implement or measure RLM's persistent root loop, recursive model calls, or unbounded semantic map.

`test/long-context-aggregate-example.test.ts` runs *this manifest* (the reduce) end-to-end through the host and
checks the exact counts (`entity 3, human 1, location 2, number 3` for users 1–3).
