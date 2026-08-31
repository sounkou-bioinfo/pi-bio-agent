# Branch handoff packets

`.handoff/current.json` is an optional, branch-scoped transfer packet for incomplete work.

Use it only when responsibility is being transferred, work is interrupted, a decision blocks progress, or an
independent verification pass should begin. It is not a diary and it is not a permanent project-memory store.

Rules:

1. Conform to `handoff.schema.json`.
2. Record the exact branch and HEAD commit. If the worktree is dirty, list the uncommitted paths.
3. Point to issues, PRs, commits, tests, logs, and owning docs instead of copying their contents.
4. Do not include secrets, private chain-of-thought, full diffs, or large logs.
5. Update the packet when handing off again after the branch moves.
6. Delete `current.json` before final merge after durable knowledge has moved to code, tests, docs, issues, or the PR.

See `docs/handoff.md` for the full contract and `current.example.json` for a minimal example.
