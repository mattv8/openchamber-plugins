# Git Graph domain constraints

## Canonical source and delivery boundary

- PR #3008 at `5186bb6b17e6c5ebc1ade97bfd000d858d8e4d92` is canonical. Preserve its
  original graph algorithm, SVG renderer, and their regression tests; a newly
  invented graph or replacement domain model is not equivalent.
- The supported package is a Work Status graph only. The dormant combined
  workspace/service code is intentionally retained for later integration and
  mutation coverage, but must remain unexposed.
- Do not revive a separate rail button, extension page, or inline commit-details
  card as substitutes for the original integration. The original cross-panel
  popover and combined workspace remain requirements awaiting host hooks.

## SDK 2.0.1 limits

- `openSurface('git')` only navigates to the native Git tab; it cannot compose
  or replace that tab's combined workspace, file tabs, staging behavior, or
  historical parent selection.
- A status-section iframe cannot draw outside itself. `setHeight` is limited
  to 24–320px, so it cannot recreate the original hover overlay. A portal or
  `overflow: visible` remains inside the iframe.
- The host owns the status-section header. Until a header-action API exists,
  controls belong in the iframe body, not an emulated native header.
- SDK theme tokens lack the original syntax-color palette. Keep deterministic
  five-series assignment, but exact PR palette fidelity awaits those tokens.

## Transport and mutation invariants

- Ref metadata/snapshot commands may use an 8 MiB internal cap, but SDK
  responses remain limited to 256 KB. Raising the internal cap cannot make an
  oversized bridge response valid; page refs within the response budget.
- Ref reads are snapshot-bound: collect every page before publishing a graph,
  reject a repeated cursor, and treat a later-page failure as failure of the
  whole read. Do not make partial refs authoritative.
- A mutation carries an operation ID and expected snapshot. Deduplicate by
  repository, reject stale state, and report an unrecoverable timeout as an
  unknown outcome rather than retrying a write automatically.
- Repository switches have a stale A/B/A and same-directory-append trap:
  ownership must remain repository-scoped and an old request must not append
  into a newly selected instance of the same directory.

## Host-test traps

- Native `openCommit` closes Work Status and unmounts its frame. Reopen Work
  Status before testing explicit section collapse. The Diff header shows an
  abbreviated hash, not necessarily the commit subject.
- Both the native rail and the extension section expose a button named `Git`.
  Scope the section locator to the `Work status` complementary landmark.
- The npm platform package supplies OpenCode 2.x executables; do not infer
  GitHub release asset URLs from the pinned `@opencode/client` version.
- Direct `POST /api/session` returns `{ data: SessionInfo }`. The official
  client unwraps `data`; the fixture's direct HTTP path must unwrap it too.
