# Example: a long-context aggregate is a `GROUP BY` (closing over RLM)

[Recursive Language Models](https://alexzhang13.github.io/blog/2025/rlm/) (RLM; Zhang & Khattab,
[arXiv 2512.24601](https://arxiv.org/abs/2512.24601)) handle unbounded context by storing it as a *variable in a
Python REPL* and recursively sub-querying an LM. On the OOLONG benchmark — *"among the instances associated with
these user IDs, how many are label X?"* over thousands of rows — RLM recurses and makes **counting errors** at
long context.

In this substrate that question is **one `GROUP BY`.** The rows live as a DuckDB table (`entries`); the agent
never sees the whole context — only the bounded result — so there is no context rot, and the count is exact:

```sql
SELECT label, count(*) AS n
FROM entries
WHERE user_id IN (1, 2, 3)     -- the "these user IDs" subset
GROUP BY label
ORDER BY label
```

The RLM REPL patterns map directly onto SQL, with `bio_query` as the loop:

| RLM (Python REPL over a string var) | here (`bio_query` over a DuckDB table) |
|---|---|
| peek (`ctx[:2000]`) | `SELECT * FROM entries LIMIT 5` |
| grep (regex narrowing) | `WHERE regexp_matches(instance, 'Calypso')` |
| partition + map (recursive LM calls) | `GROUP BY` + per-partition sub-operations |
| summarize | SQL aggregates |

The genuinely *semantic* step RLM uses an LM for — inferring each instance's label from free text — is the only
part that needs judgment; here it is a column (or, in a real run, a judgment-boundary resolver that labels rows
once and writes them back). Everything distributional is deterministic SQL.

`test/long-context-aggregate-example.test.ts` runs the manifest end-to-end through the host and checks the exact
counts (`entity 3, human 1, location 2, number 3` for users 1–3) — the determinism that RLM trades away.
