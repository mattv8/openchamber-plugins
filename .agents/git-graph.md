# Git Graph domain constraints

## Canonical source and delivery boundary

- PR #3008 at `5186bb6b17e6c5ebc1ade97bfd000d858d8e4d92` is canonical. Preserve its
  original graph algorithm, SVG renderer, and their regression tests; a newly
  invented graph or replacement domain model is not equivalent.
- The supported package is a Work Status graph only, now with host header
  controls, a cross-frame hover card, inline changed-file lists and a commit
  action menu (SDK 2.1.1 hooks). The combined-workspace UI is retained for later
  integration and mutation coverage, but must remain unexposed.
- Do not revive a separate rail button, extension page, or inline commit-details
  card as substitutes for the original integration. The native combined
  workspace and per-file native diff tabs remain requirements awaiting host hooks.

## SDK 2.1.1 contract

- Feature-gate every hook on `ready.features` (`statusControls`, `popovers`,
  `deviceStorage`). Without them the body controls and server storage remain.
- `openSurface('git')` only navigates; `openCommit` opens a whole commit, so a
  changed-file click must say it opens the whole commit.
- One popover per host document: opening another replaces it. Hover previews
  stand aside while the action menu is open (`popover/menu-state.ts`). Popover
  IDs must match `^[A-Za-z0-9_-]{1,80}$`; menu IDs start with `menu-`, and only
  their closes reload the graph. Payloads stay within 16,000 characters.
- Popover children get only `ready.directory` and must `repo/open` themselves.
  They never receive `onPopoverClosed`; that event goes to the owner frame.
- Status frames stay at most 320px. Graph colors come from `--oc-syntax-*`.

## Popover writes

- Writes run only in the menu popover. A durable device-storage record
  (`git-graph:op:<repositoryId>`) is written and awaited before `mutate`; if it
  cannot be written, or one is unresolved, nothing is submitted.
- Recovery queries `operations/get` only. Never resubmit, never mint a new
  operation ID without a fresh user gesture, and never treat `retryable` as
  permission to repeat a write.
- Hard reset is built with `force: false`; only the confirm handler sets it.
  The reviewed snapshot from the confirm view is the `expectedSnapshot`.

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
