# Hooks needed to preserve the Git workspace from PR #3008

The target is the interface in [PR #3008](https://github.com/openchamber/openchamber/pull/3008), using its original graph, commit popover, and combined Git workspace. The extension must use the existing Git entry point. A second rail button or standalone extension page is not an acceptable replacement.

This note compares that requirement with the published `@openchamber/sdk@2.0.1` contract and OpenChamber source commit `ffa12ea39b00c0fe1f2b9c9f56b7aefc6ff3fcce`. The reference implementation is PR head `5186bb6b17e6c5ebc1ade97bfd000d858d8e4d92`.

## What the existing hooks provide

- `contributes.statusSection` gives the graph a Work Status section without adding a rail panel, when the manifest omits `panel.entry`.
- `host.setHeight` resizes that section's iframe between 24 and 320 CSS pixels. Taller content scrolls within the frame.
- `host.openCommit(sha)` selects a commit in the host's native Diff view. The host resolves the SHA against the current project.
- `host.openSurface('git')` opens the existing native Git tab. It provides navigation, not a way to supply that tab's content or the combined layout from the PR.
- The service and storage APIs support extension-owned Git operations and preferences.

These hooks are enough to render the original graph model and compact rows. They do not expose the native Git workspace or an overlay outside the iframe.

## Missing integration points

### 1. Use the existing Git entry point for the combined workspace

**Required behavior:** opening the existing Git control shows the PR's combined layout: file diff tabs on the left; Changes, Commit, and the resizable graph on the right. Selecting a changed file activates its own diff tab. Working-tree and historical selections retain their different staging and parent-selection behavior.

**Current limitation:** the SDK's `panel` and `page` contributions create additional extension surfaces. They do not attach to or replace the built-in Git context-panel surface. A page requires a panel entry; it is not a way to keep this integration invisible in navigation. `openCommit` opens a native commit diff, but does not mount the combined workspace or control its file tabs.

**Hook needed:** an opt-in extension contribution to the existing Git surface, with an explicit selection contract for working-tree files and historical commit files/parents. The host should retain its existing Git entry point and navigation. The exact API shape is for the maintainer to decide; no proposed API name in this document is implemented.

**Original code:** `ContextPanel.tsx`, `GitView.tsx`, `GitWorkspacePanes.tsx`, `GitDiffTabsPane.tsx`, `DiffView.tsx`, and the commit-file preview/controller modules.

### 2. Show the original commit popover outside the status iframe

**Required behavior:** hovering or focusing a graph row shows the original floating card, including author/time, commit message, changed-file counts, insertion/deletion totals, reference chips, copy-SHA, and remote-link actions. The pointer can move into the card to use its actions. The card can extend over adjacent host content, as it does in the PR screenshots.

**Current limitation:** a portal in an extension frame stays in that frame's document. Neither `overflow: visible` nor `setHeight` lets it draw outside the iframe. The 320px section cap also prevents using height expansion as an equivalent overlay. The SDK exposes no general anchored host-overlay contribution.

**Hook needed:** a host-owned anchored overlay surface for extension content, with a row anchor, pointer/focus handoff, dismissal, viewport collision handling, theme context, and cleanup when the section closes or the project changes. This should retain the sandbox; the extension should not reach into the parent DOM.

**Original code:** `GitCommitHoverPopover.tsx`, `gitCommitHoverModel.ts`, `gitCommitHoverCache.ts`, and `HistoryCommitRow.tsx`.

### 3. Put graph controls in the Work Status section header

**Required behavior:** the existing Git section header contains the compact auto/all/manual controls and refresh icon, aligned as in PR #3008.

**Current limitation:** `statusSection` accepts an entry, title, and starting height. Its header is host-owned, and the extension can render controls only inside the body iframe.

**Hook needed:** a section-header action contribution or a separate sandboxed header-action slot. Until then, the graph controls remain inside the section body; exact header placement is deferred.

**Original code:** `WorkStatusGitGraphSection.tsx` and `GitGraphControls.tsx`.

### 4. Preserve the host theme's original graph palette

**Required behavior:** retain the original five branch colors for the active theme. PR #3008 derives `--git-graph-1` through `--git-graph-5` from the theme's syntax keyword, string, number, function, and type colors.

**Current limitation:** `HostThemeTokens` exposes semantic UI/status colors but not these syntax colors or the graph palette. The extension preserves the original deterministic color assignment and five CSS variables, but their current values must use the SDK's available theme colors. Exact palette matching is therefore not yet delivered.

**Hook needed:** expose the graph palette or those syntax tokens in the host theme snapshot, updating them with theme changes.

**Original code:** `CSSVariableGenerator.getGitGraphSeries` in `packages/ui/src/lib/theme/cssGenerator.ts`, and `gitGraph.ts`.

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
