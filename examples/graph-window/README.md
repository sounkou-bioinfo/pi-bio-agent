# Graph Window

This example materializes a tiny edge-shaped table and then pages it with the portable CLI:

```sh
pi-bio-agent query examples/graph-window/manifest.json \
  --db .pi/bio-agent/readme-graph-window.duckdb \
  --sql "SELECT count(*) AS n FROM bio_edges"

pi-bio-agent graph-window \
  --db .pi/bio-agent/readme-graph-window.duckdb \
  --table bio_edges \
  --start run:readme \
  --direction both \
  --limit 10
```

The point is the interface, not the fixture: any DuckDB table with `from_id`, `predicate`, and `to_id` can be
windowed this way, including `bio_edges_as_of`, `entailed_edge`, and schema-qualified external KG tables.
