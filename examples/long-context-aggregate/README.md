# Deterministic reduction over external context

The manifest stores labeled entries as a DuckDB relation. The actor inspects bounded rows and computes exact counts
without placing the complete context in a prompt:

```sql
SELECT label, count(*) AS n
FROM entries
WHERE user_id IN (1, 2, 3)
GROUP BY label
ORDER BY label
```

This is the reduction half of a long-context classification task. Because labels already exist, it does not perform
the semantic map and does not implement a Recursive Language Model.

The executable [partitioned labeling pattern](../patterns/map-reduce-labeling.md) starts from unlabeled text, runs a
deterministic SQL stand-in across isolated processes, merges artifacts through the host, and then reduces. A real RLM
evaluation must replace that stand-in with recursive model calls and compare quality and budget against a baseline.

`test/long-context-aggregate-example.test.ts` verifies the manifest's exact reduction. The pattern and test establish
data-plane mechanics only.
