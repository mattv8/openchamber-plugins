# Hooks needed to preserve the Git workspace from PR #3008

The target is the interface in [PR #3008](https://github.com/openchamber/openchamber/pull/3008), using its original graph, commit popover, and combined Git workspace. The extension must use the existing Git entry point. A second rail button or standalone extension page is not an acceptable replacement.

This note compares that requirement with the published `@openchamber/sdk@2.0.1` contract and OpenChamber source commit `ffa12ea39b00c0fe1f2b9c9f56b7aefc6ff3fcce`. The reference implementation is PR head `5186bb6b17e6c5ebc1ade97bfd000d858d8e4d92`. Re-audited against the PR source and tests on 2026-09-25; npm still identifies SDK 2.0.1 as the latest release. This is a versioned comparison, not a claim about unpublished SDK work.

**Assessment:** the original four gaps were directionally correct but incomplete. Native file-tab routing and comparison bases, device-local persistence, layout/settings ownership, section lifecycle, Git refresh coordination, and optional authenticated hover enrichment also need explicit contracts. Some fit within the original four hooks; they do not each require a separate SDK API.

The target platforms are desktop web and Electron. Preserve narrow-web fallback and leave unsupported mobile hosts alone. VS Code integration is outside this extension's scope. The PR's non-goals still apply: no arbitrary branch-to-branch comparison, no per-session change attribution, and no change to staging, commit, sync, revert, or branch-operation semantics.

## What the existing hooks provide

- `contributes.statusSection` gives the graph a Work Status section without adding a rail panel, when the manifest omits `panel.entry`.
- `host.setHeight` resizes that section's iframe between 24 and 320 CSS pixels. Taller content scrolls within the frame.
- `host.openCommit(sha)` selects a commit in the host's native Diff view. The host resolves the SHA against the current project.
- `host.openSurface('git')` opens the existing native Git tab. It provides navigation, not a way to supply that tab's content or the combined layout from the PR.
- The service and storage APIs support extension-owned Git operations and server-instance/package-scoped preferences. Storage is shared by clients of that host; it is not device-local persistence.
- `onDirectory`, workspace/session subscriptions, and `onConnection` provide context changes; they are not repository-content change subscriptions.
- The ready context includes locale and semantic theme tokens. The extension can own translations; it does not need access to the host's translation implementation.
- `writeClipboard`, `openUrl`, and `toast` already support the popover's copy/link feedback. The missing overlay is a placement and interaction contract, not a lack of these actions.

These hooks are enough to render the original graph model and compact rows. They do not expose the native Git workspace or an overlay outside the iframe.

## Missing integration points

### 1. Use the existing Git entry point for the combined workspace

**Required behavior:** when the user selects the combined review layout, the existing Git control shows file diff tabs on the left and Changes, Commit, and the resizable graph on the right. Separate views remain the default. Preserve the native close/return-to-chat flow, split resizing, and the same entry points used by Changes and chat diff links.

Combined mode routes file diffs to the main workspace and hides the redundant native Diff rail entry. Integrating only the Git body without that navigation change does not reproduce the PR.

The contribution must participate in host layout selection. In the PR, web widths of 768px or less retain the legacy inline composition; Electron uses workspace panes. Measuring the width of the guest iframe is not equivalent to knowing the host viewport or desktop-shell mode. This can be handled by the host selecting the appropriate contribution; it need not expose arbitrary layout-store access.

**Current limitation:** the SDK's `panel` and `page` contributions create additional extension surfaces. They do not attach to or replace the built-in Git context-panel surface. A page requires a panel entry; it is not a way to keep this integration invisible in navigation. `openCommit` opens a native commit diff, but does not mount the combined workspace or control its file tabs.

**Hook needed:** an opt-in contribution to the existing Git surface that can compose the required panes, preserve native navigation, and declare its supported layout modes. Establish whether the host mounts its native Changes/Commit/Diff components or the plugin owns those components inside that surface. The former needs composition slots; the latter still needs native selection/routing and refresh interoperability below. The exact API shape is for the maintainer to decide; no proposed API name in this document is implemented.

### 1a. File-diff targets in both Separate and Combined layouts

`openCommit(sha)` is insufficient for the PR's per-file review flow even without the combined workspace. The original Work Status graph expands a commit's changed-file list and opens the selected file through `openContextCommitDiff`; it does not just open the whole commit. Both layouts need a public file-target contract. The integration needs to preserve:

- Working-tree file selection with its diff scope, and historical selection with commit hash, resolved comparison base, and changed-file metadata, including old paths for renames. The PR calls the base field `parentHash`, but it also carries upstream, merge-base, or a selected ref revision; it is not restricted to a literal parent. Preserve the graph's comparison label and clear-comparison behavior. This is commit-against-ref comparison, not the excluded arbitrary branch-to-branch comparison feature.
- One selected file per tab; opening that target again activates/updates its existing tab rather than opening an aggregate commit diff. Tabs can be activated, closed, and reordered; their selection survives switching between Git and chat.
- Historical root/merge-commit parent handling and read-only previews; working-tree review retains its native file/hunk staging, unstaging, and revert controls. Existing editor-opening actions must remain functional through the native diff view or an equivalent sanctioned host action.
- A repository/runtime-bound host request so delayed selection cannot be applied to a newly selected project. This is a boundary requirement for the extension; the PR's persisted tab store itself is keyed by directory. Synchronize selections made by the native Changes list, graph, and chat diff links rather than maintaining unrelated copies of native selection state.

The host may own the tab strip and accept typed targets, or mount an extension-owned strip and forward native selection events. The PR's exact store shape and its tab-cache limits do not need to become public SDK contracts.

**Original code:** `ContextPanel.tsx`, `ContextPanelRail.tsx`, `lib/surfaces/registry.ts`, `lib/getWorkingTreeDiffDestination.ts`, `GitView.tsx`, `GitWorkspacePanes.tsx`, `gitViewRenderMode.ts`, `GitDiffTabsPane.tsx`, `contextPanelDiffTabs.ts`, `useGitDiffTabsStore.ts`, `useUIStore.openContextDiff/openContextCommitDiff`, `DiffView.tsx`, `ContextCommitDiffView.tsx`, `gitCommitDetailsController.ts`, `gitContextCommitDetailsController.ts`, and `GitGraphPanel.tsx`.

### 2. Show the original commit popover outside the status iframe

**Required behavior:** hovering or focusing a graph row shows the original floating card, including author/time, commit message, changed-file counts, insertion/deletion totals, reference chips, copy-SHA, and remote-link actions. The pointer can move into the card to use its actions. The card can extend over adjacent host content, as it does in the PR screenshots.

**Current limitation:** a portal in an extension frame stays in that frame's document. Neither `overflow: visible` nor `setHeight` lets it draw outside the iframe. The 320px section cap also prevents using height expansion as an equivalent overlay. The SDK exposes no general anchored host-overlay contribution.

**Hook needed:** a host-owned anchored overlay surface for extension content, with iframe-to-host anchor coordinates, pointer/focus handoff, dismissal, viewport collision handling, theme context, and cleanup when the section closes or the project/runtime changes. Scrolling or removing the anchor must reposition or dismiss the overlay. This should retain the sandbox; the extension should not reach into the parent DOM.

Apply the same boundary analysis to the graph's manual-ref picker, commit context menus, and compare-with-ref/create-branch/create-tag/confirmation dialogs: a host-sized surface or overlay is needed wherever those controls must extend beyond the frame. An in-frame portal is sufficient only when clipping does not change the original interaction. Confirmation and conflict-recovery UI for Git writes must remain reachable; solving the read-only hover alone does not integrate those actions.

**Original code:** `GitCommitHoverPopover.tsx`, `gitCommitHoverModel.ts`, `gitCommitHoverCache.ts`, and `HistoryCommitRow.tsx`.

### 3. Work Status header, presence, and expansion lifecycle

**Required behavior:** the existing Git section header contains the compact auto/all/manual controls and refresh icon, aligned as in PR #3008. The original section defaults to collapsed, reports presence only with a directory and Git runtime, and performs graph/hover work only while visible and expanded.

**Current limitation:** `statusSection` accepts an entry, title, and starting height. Its header is host-owned, and the extension can render controls only inside the body iframe. `WorkStatusExtensionSection` reports presence unconditionally, uses `defaultExpanded`, and unmounts its iframe when folded/hidden. The guest has no declared default-expansion/presence contract or host-header controller; a collapsed guest cannot run body code to manage its header. Height is remembered only for the host session, keyed by extension id/version.

**Hook needed:** a section-header action contribution or a separate sandboxed header-action slot, plus an explicit presence/default-expansion contract. Define header operation while the body is unmounted and body activation/cleanup semantics. Existing unmount/remount behavior may supply lifecycle cleanup; a permanent hidden iframe is not required. Until then, body controls and the host's default expansion behavior are a supported approximation, not exact fidelity.

The PR's Work Status graph body is 320px, so its size alone does not require lifting the SDK's 320px cap. The separately resizable combined-workspace graph belongs to the native-surface/layout contract, not to oversized status frames.

**Original code:** `WorkStatusGitGraphSection.tsx` and `GitGraphControls.tsx`.

### 4. Preserve the host theme's original graph palette

**Required behavior:** retain the original five branch colors for the active theme. PR #3008 derives `--git-graph-1` through `--git-graph-5` from the theme's syntax keyword, string, number, function, and type colors.

**Current limitation:** `HostThemeTokens` exposes semantic UI/status colors but not these syntax colors or the graph palette. The extension preserves the original deterministic color assignment and five CSS variables, but their current values must use the SDK's available theme colors. Exact palette matching is therefore not yet delivered.

**Hook needed:** expose the graph palette or those syntax tokens in the host theme snapshot, updating them with theme changes.

**Original code:** `CSSVariableGenerator.getGitGraphSeries` in `packages/ui/src/lib/theme/cssGenerator.ts`, and `gitGraph.ts`.

### 5. Native review-layout settings and preference ownership

**Required behavior:** the PR adds Separate/Combined to the existing Git settings and settings search. Fresh installs remain Separate. Valid server `gitReviewLayout` values synchronize normally; missing/invalid values do not overwrite the local choice. Graph-pane collapse and height are device-wide across repositories, while graph filters/manual refs and other repository pane state remain repository/runtime-scoped. The migration drops ambiguous legacy per-repository graph height/collapse rather than guessing a winner.

**Current limitation:** `host.storage` supports package-owned JSON persistence, but does not expose native Git settings, their settings-search placement, existing device-local UI preferences, or their migration. It writes one server-side `guest-storage/<id>.json` per extension: clients connected to that server share it. The sandboxed guest has no same-origin permission and cannot substitute its own browser localStorage. Prefixing keys with a repository preserves repository separation, but does not supply device identity or device-local storage. `onSettings` delivers the extension's integration settings; it is not an API for reading/writing the native `gitReviewLayout` preference. The manifest's integration text fields do not mount a native Git settings control.

**Hook needed:** give the contributed native Git surface a sanctioned settings contribution and a clearly owned layout preference, including read/update/subscription and scope semantics. Supply device-local persistence for graph layout and tab state, or let the host own that state on behalf of the contribution. The plugin can retain existing server-scoped storage for other preferences. If compatibility with existing PR-build preferences is required, the host must provide the migration path; reading host-private localStorage keys or `settings.json` is not an SDK contract.

Pane resizing and in-memory tab behavior are plugin-implementable once the native surface is available. Persisting them with server-scoped `host.storage` would be a behavioral deviation: two devices could overwrite each other's layout. Preserve the PR's device-local persistence, device-wide graph layout across repositories, and repository/runtime-specific filter state.

**Original code:** `GitSettings.tsx`, `stores/useUIStore.ts` and its context-panel tests, `stores/useGitDiffTabsStore.ts`, `stores/utils/safeStorage.ts`, `GitWorkspacePanes.tsx`, `lib/settings/registry.ts` (`gitReviewLayout`), and `packages/web/server/lib/opencode/settings-helpers.js`. SDK storage ownership is implemented in `packages/web/server/lib/guests/storage.js` at the pinned host.

### 6. Keep native Git UI and extension state current together

**Required behavior:** external Git activity and successful native/plugin mutations invalidate the affected repository's graph, status, and diff views. Hidden views defer fetch work until activated; changing repository/runtime cannot apply stale results. A successful plugin operation must not leave the native Changes list or an open native diff stale, and native operations must not leave the extension graph stale.

**Current limitation:** the SDK exposes directory/session/worktree context updates but no Git-content change subscription or mutation/invalidation hint back into native Git state. `serviceRequest` is request/response to the plugin's own service, not access to the host event stream or native Git runtime. A plugin-owned watcher and snapshot polling can keep plugin data current, but they are not the PR's shared host refresh coordination.

The PR also emits refresh hints after relevant agent tools finish (`bash`, `edit`, `write`, `apply_patch`, `patch`). The SDK's `onSessionLifecycle` gives a coarse current-session started/completed/failure signal, not equivalent per-tool or repository-content events.

**Hook needed for the combined native integration:** a repository-scoped change/invalidation channel in both directions, with optional changed paths and explicit connection/runtime ownership. It should cover host mutation hints and relevant external-change notifications, and allow a plugin to request native revalidation after a write or uncertain outcome. A hint requests a fresh authoritative read; it must not report an operation as successful. Define reconnection/activation revalidation so missed events do not leave views permanently stale.

This is not a request to expose all private Git routes or move Git execution into the SDK. The plugin can retain its bounded watcher, Git operations, queues, operation journal, pagination, and caches. The missing contract is coordination across the host/extension boundary. It is not required merely to draw a self-contained status graph.

**Original code:** `hooks/useGitRefreshCoordinator.ts`, `withGitMutationRefreshHints` in `lib/api/gitMutationHints.ts`, `lib/sessionEvents.ts`, the Git refresh handling in `sync/sync-context.tsx`, `stores/useGitStore.ts`, and `packages/web/server/lib/git/{watcher,routes}.js`. The PR's `openchamber:git-changed` server UI event is a host-runtime facility, not an SDK event.

### 7. Optional GitHub enrichment in the original popover

**Required parity when available:** the native popover uses the host's connected GitHub account to enrich the local commit with GitHub author/login/avatar and a commit URL. It falls back to local Git metadata and a remote-derived link when GitHub is unavailable. Preserve that fallback; do not make local history depend on authentication.

**Current limitation:** the PR calls `RuntimeAPIs.github.commitDetails(directory, hash, remote)`. SDK 2.0.1 has no equivalent or host GitHub integration provider (`integration.host` supports Linear). `host.request` targets a declared integration origin; it is not arbitrary access to the host's authenticated GitHub routes. Generic OAuth/token integrations exist, but a second extension-specific login is not reuse of the user's existing native GitHub connection.

**Hook needed for connected-host parity:** a sanctioned host-backed commit-enrichment request or an equivalent host-rendered enrichment facility, keeping credentials host-owned and respecting the chosen repository/remote. Avatar rendering must also work through the host overlay or an allowed image path. Returning a URL alone does not establish that a sandboxed frame may load it. Local metadata and link actions need neither this hook nor new authentication.

**Original code:** `WorkStatusGitGraphSection.tsx`, `GitCommitHoverPopover.tsx`, `gitCommitHoverCache.ts`, `gitCommitRemote.ts`, and `packages/web/server/lib/github/commit-details-route.js`. This is an omitted optional capability of the original popover, not a blocker for its offline form.

## Work that does not require an SDK update

- Preserve the original graph algorithm, SVG geometry, ref grouping, compact row styling, and localized strings inside the guest.
- Run Git reads/writes through the approved plugin service. Keep staging/commit/sync/branch operations, confirmations, conflict recovery, full-SHA validation, and operation-outcome reconciliation in the plugin or retained native controls.
- Implement bounded Git metadata reads, snapshot-bound history/ref pagination, chunked diff/blob reads, binary/oversize/symlink/gitlink handling, and stale-request guards. SDK request/response limits require bounded transport; they do not imply that a new unbounded Git API is necessary.
- Persist server-instance/package-scoped extension preferences with existing storage, including repository-prefixed keys. Device-local layout/tab persistence, access to native settings, and migration of native preferences remain separate requirements above.
- Copy hashes, open remote links, show feedback, and use locale/semantic theme tokens through the existing host bridge.

These are implementation and parity checks, not claims that every retained plugin feature is already delivered.

## Completion checks for the maintainer handoff

1. An opt-in Combined setting uses the existing Git entry, preserves Separate by default, retains the narrow-web fallback, and returns to chat through the native flow.
2. Working and historical file selections reach the appropriate native file tab from graph, Changes, and chat in both layouts. First/merge-parent, upstream, merge-base, and available ref comparisons preserve the chosen base and label; stage/unstage/revert controls remain appropriate to the selected scope. Range-ref resolution must not silently substitute a different remote ref when a requested local range is unavailable.
3. Hover/pickers/menus are usable at frame and viewport edges; keyboard/pointer handoff works, and closing a section or changing repository disposes stale overlays.
4. Work Status reproduces header controls, conditional presence, and default collapse. Combined graph resizing and preference scopes survive navigation/restart without per-repository height migration guesses; two clients of one host retain independent device-local layouts.
5. Native, external, and plugin Git changes refresh both native and extension views, including after hidden periods, reconnects, and project/runtime switches.
6. Theme changes preserve the five original graph colors. Connected GitHub enrichment works when available, while offline/local hover remains usable.

## Current delivery boundary

The installable package contributes only the Work Status graph. It does not add a Git Graph rail button or page. It uses the original graph algorithm and SVG renderer, with source provenance and their regression tests.

The cross-panel popover and native combined workspace remain deferred. The rejected inline commit-details card and separate workspace are not substitutes for them. Existing service/write-workflow code remains in the repository for later integration; its presence does not mean the native workspace is delivered.

No OpenChamber core patch or SDK pull request is included. This document is the maintainer handoff for deciding the missing integration contracts.

## Contract evidence

In the pinned OpenChamber source:

- `packages/sdk/src/manifest.ts`: `OpenChamberContributes`, `StatusSectionContribution`, and the 24–320px height limits.
- `packages/sdk/src/parse.ts`: page/panel-entry requirements and status-only contribution validation.
- `packages/sdk/src/host.ts`: the public `HostClient` methods, including `openCommit` and `setHeight`.
- `packages/sdk/src/contract.ts`: the public `HostThemeTokens` fields.
- `packages/ui/src/components/chat/work-status/WorkStatusExtensionSection.tsx`: host-owned section header and sandboxed body.
- `packages/ui/src/lib/guests/open-commit.ts`: commit selection and native Diff navigation.
- `packages/sdk/src/workspace.ts`: package-owned storage and workspace-context snapshots, not native Git settings or Git-content events.
- `packages/sdk/src/manifest.ts`: integration settings and the supported host integration providers; no native Git settings contribution or host GitHub provider.

PR source paths above are rooted in `packages/ui/src/` unless another root is given. Compare them at [the exact PR head](https://github.com/openchamber/openchamber/tree/5186bb6b17e6c5ebc1ade97bfd000d858d8e4d92), and SDK/host paths at [the pinned official host](https://github.com/openchamber/openchamber/tree/ffa12ea39b00c0fe1f2b9c9f56b7aefc6ff3fcce). API names in the "Hook needed" paragraphs describe requirements, not implemented proposals.
