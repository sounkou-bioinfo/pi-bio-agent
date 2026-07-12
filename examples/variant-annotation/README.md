# Batched variant annotation as manifest and SQL

This manifest declares one within-limit VEP-style batch through `ducknng_ncurl_table`. A binding supplies the ids;
SQL composes the POST body, unnests nested transcript and colocated-variant structures, and filters by consequence,
frequency, and significance. No source-specific TypeScript client is involved.

The deterministic test uses a local DuckNNG HTTP route that rejects missing/empty ids and returns a nested response.
It proves that the body is sent and that every SQL predicate is load-bearing.

One response table and multi-request fanout are different contracts:

- `ducknng_ncurl_table` materializes one response;
- `ducknng.http_fanout` / `ncurlFanout` launch bounded batches, drain all handles, retry transient failures, and
  terminate permanent failures;
- the workbench clinical application and WGS example exercise that fanout path.

The host provisions DuckNNG, TLS, credentials, and network policy. The manifest supplies URL/body SQL and bindings.
The library is not an egress sandbox.

Run the hermetic contract test:

```sh
npm test -- --test-name-pattern="Variant Annotation-shaped"
```

Inspect [manifest.json](manifest.json) for the complete resource and SQL. The example normalizes a deliberately small
VEP-shaped fixture; production allele normalization and source semantics remain application work.
