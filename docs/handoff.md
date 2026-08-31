---
type: Reference
title: Agent handoff and project orientation
description: "The branch-scoped contract for transferring exact work state between coding agents and maintainers without relying on chat history."
tags: [agents, handoff, orientation, development, verification]
---

# Agent handoff and project orientation

This document is about **development handoff**. It is not a runtime agent protocol, workflow abstraction, memory model,
or scientific control plane.

The problem is narrower and more practical:

> A coding agent or maintainer should be able to enter an active branch, recover the exact state of the work, verify
> what is true, and continue from the correct next step without relying on the previous conversation or repeating
> repository archaeology.

The repository already has durable sources of truth: Git, tests, owning design documents, issues, pull requests, and
executable examples. A handoff packet links those sources together for one active piece of work. It does not replace
them.

## Source-of-truth order

When sources disagree, use this order:

1. **The checked-out tree and Git history**: what code and documentation actually exist.
2. **Tests, generated-file checks, and recorded command results**: what has been verified.
3. **Owning design documents and `AGENTS.md`**: the current architectural and repository contracts.
4. **The issue or pull request**: the accepted objective, discussion, and review state.
5. **`.handoff/current.json`**: the latest branch-local transfer snapshot.
6. **Chat transcripts and scratch notes**: useful clues, never authoritative state.

A handoff packet may point out a discrepancy between these sources. It may not silently choose the conversational
version over the repository.

## Orientation sequence

A new agent should be able to begin with this bounded sequence:

1. Read `AGENTS.md`.
2. If `.handoff/current.json` exists, read it and verify that its branch and `head_sha` match the checkout. If the
   worktree is marked dirty, compare the listed uncommitted paths with `git status --short`.
3. Read the linked issue or pull request and the owning design document named by the packet.
4. Inspect only the packet's `read_first` paths and symbols before widening the search.
5. Run the smallest recorded verification or reproduction command that establishes the current boundary.
6. Continue from the first ordered `next_actions` entry whose blockers are satisfied.

If the packet is stale, stop treating it as current. Reconstruct state from Git, tests, and the PR, then replace or
remove the packet.

## What belongs in a handoff packet

The branch-local packet lives at `.handoff/current.json` and conforms to `.handoff/handoff.schema.json`.

It contains only information needed to resume the present work:

- repository, base branch, working branch, exact HEAD, and clean/dirty worktree state;
- issue/PR references;
- objective and falsifiable acceptance criteria;
- scope and explicit non-goals;
- current phase and a compact state summary;
- the minimal files and symbols to read first;
- changed and uncommitted paths grouped by concern;
- decisions already made, with evidence or discussion references;
- invariants and boundaries the next agent must preserve;
- exact verification commands, working directories, outcomes, and timestamps;
- known failures, unverified claims, blockers, risks, and uncertainties;
- ordered next actions, each with a starting location and a concrete `done_when` condition;
- relevant artifacts, logs, commits, issues, PRs, and generated outputs by stable reference.

It does **not** contain:

- private chain-of-thought;
- complete diffs, copied logs, or large command output;
- secrets, credentials, tokens, private URLs, or machine-specific environment values;
- broad repository summaries already owned by `AGENTS.md` or design documents;
- speculative architecture unrelated to the current objective;
- claims that a test passed when it was not run.

## Handoff lifecycle

A packet is created or refreshed at an actual transfer boundary:

- another agent or maintainer will take over;
- the current session is ending before the work is complete;
- progress is blocked on a user or maintainer decision;
- implementation is ready for an independent verification pass;
- a long-running command or external dependency prevents completion in the current session.

Do not update it after every edit. It is a checkpoint for responsibility transfer, not a work diary.

The packet is branch-scoped:

- commit it when another checkout or agent needs to receive it;
- update it whenever the branch moves after a handoff and another transfer is expected;
- delete it before final merge unless the branch remains intentionally resumable after the merge;
- move durable knowledge to its canonical location before deletion.

A final PR body is the human-readable projection of the completed work. The branch packet is for incomplete or
transferred work.

## Handoff status values

Use these meanings consistently:

| Status | Meaning |
|---|---|
| `planned` | Objective and acceptance are recorded; implementation has not started. |
| `in_progress` | Work has started and the current tree is not ready for review. |
| `blocked` | No valid next implementation action exists until a named decision or dependency is resolved. |
| `ready_for_verification` | Implementation claims are complete; an independent pass should run the listed checks and review risks. |
| `ready_for_review` | Verification recorded no unresolved blocking issue; PR review is the next boundary. |
| `completed` | Acceptance criteria are met and durable knowledge has been promoted; the packet should normally be removed. |

Do not use `blocked` merely because work is difficult. Name the missing decision, dependency, credential, fixture, or
external result.

## Verification evidence

Every verification entry records:

- the exact command;
- the directory in which it was run;
- `passed`, `failed`, `not_run`, or `interrupted`;
- the observed timestamp;
- a concise result or a stable log/artifact reference;
- whether the result applies to committed HEAD or includes listed uncommitted changes.

A handoff must distinguish:

```text
verified at HEAD
verified only before the latest edits
known failing before this work
new failure caused by this work
not run because the dependency is unavailable
```

This prevents the next agent from either trusting stale success or wasting time rediscovering an already-characterized
failure.

## Decisions, invariants, and uncertainties

These are different fields.

- **Decision**: a choice already made for this work, with its reason and reference.
- **Invariant**: a repository or subsystem property that must remain true.
- **Uncertainty**: a fact not yet established and the cheapest discriminating check.
- **Blocker**: an uncertainty or dependency that prevents every valid next action.
- **Risk**: a known failure mode that does not necessarily stop progress.

A useful decision entry records the alternatives that matter and the evidence that selected one. It does not reproduce
internal deliberation.

## Next-action quality

A next action must be executable by someone who did not participate in the previous session.

Weak:

```text
Continue implementing the scheduler.
```

Strong:

```text
Open `src/hosts/job-queue.ts` at `claimJob()`. Add a failing deterministic-clock test in
`test/job-queue.test.ts` for stale-owner allocation release. Done when the test fails for the current implementation
and names the expected `JobClaimLostError` boundary.
```

Each next action should name:

- the action;
- the first file, symbol, issue, or command to inspect;
- its blockers;
- the observable completion condition.

Keep the ordered list short. Longer future work belongs in an issue or roadmap, not in a branch handoff.

## Parallel work and ownership

A packet records the work currently owned by the branch, not the whole project.

When work is split:

- create separate issues/branches for independently reviewable outcomes;
- state which files or contracts overlap;
- link the sibling PRs or commits;
- identify the integration order when it matters;
- do not let two packets both claim ownership of the same unresolved transition without an explicit coordination note.

The next agent should be able to tell whether a change on another branch invalidates the packet's assumptions.

## Accretion: where knowledge should go

Handoff should make the repository more legible over time without accumulating stale branch notes.

| Discovered knowledge | Canonical destination |
|---|---|
| Cross-cutting architecture or invariant | the existing owning design document |
| Public API or user behavior | README source, user guide, reference docs, or schema |
| Code-level contract or edge case | types, doc comments, and focused tests |
| Reproduction or verification procedure | executable test, script, Make/npm target, or QMD |
| Current branch state and next action | `.handoff/current.json` |
| Deferred independently valuable work | issue or the current consumer-pulled refinements/roadmap entry |
| Benchmark result or compatibility evidence | committed fixture/output with the command that generated it |
| Rejected idea with no continuing relevance | nowhere; delete it |

A handoff is successful when transient context disappears after transfer while durable knowledge remains in the right
place.

## Repository-specific orientation map

For `pi-bio-agent`:

- `AGENTS.md` owns repository-wide coding rules and the start sequence.
- `docs/INDEX.md` is the generated map of focused design documents.
- `docs/design.md` owns shared conceptual boundaries.
- `docs/domain-model.md`, `docs/duckdb-substrate.md`, `docs/concurrency.md`, and the other focused references own their
  mechanisms.
- `README.qmd` owns the generated README.
- tests and executable QMD examples are stronger evidence than copied prose.
- issues and PRs own active scope, review, and unresolved user decisions.
- `.handoff/current.json` owns only the latest branch transfer state.

## Quality criteria

The handoff system is doing its job when a fresh agent or maintainer can:

- identify the objective, acceptance criteria, and non-goals without reading a transcript;
- find the first relevant files and symbols without broad search;
- know exactly what changed and which checks apply;
- distinguish verified facts from assumptions and stale claims;
- reproduce the current failure or success boundary;
- take one correct next action without a clarification round;
- avoid repeating completed exploration;
- promote reusable knowledge and remove the transient packet before merge.

Useful measurements include time to first valid change, number of unnecessary files opened, repeated commands, false
assumptions, clarification questions, and verification duplicated after transfer.
