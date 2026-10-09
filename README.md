# Git Graph plugin

An installable Work Status Git graph for OpenChamber, restoring the compact graph, header controls and commit hover card from PR #3008. The original native combined workspace awaits additional host hooks.

The browser panel never invokes Git directly. It calls the plugin-owned loopback service using the versioned schemas exported from `src/shared/protocol.ts`. The service must validate every request, serialize writes per common Git directory, and reconcile a timed-out mutation before retrying it.

`bun run build -- git-graph` creates the panel IIFE, status-section HTML, CSS, Node service, and release manifest. `bun run package -- git-graph` produces `artifacts/git-graph/git-graph.zip` and `SHA256SUMS`.

The release package root has a real `package.json` with an official v2 manifest. It requires OpenChamber `>=2.1.1` and contributes only a Git status section. It adds no rail panel or standalone page.

## Install

For Git-based update checks, choose **Settings → Extensions → Add** in OpenChamber and enter:

```text
https://github.com/mattv8/openchamber-plugins.git#git-graph
```

The `git-graph` branch contains the precompiled plugin at its root. Keep the branch suffix: `main` is the source workspace, not an installable extension. OpenChamber checks the stored branch for updates; use its extension update controls to apply them. It does not automatically install updates in the background.

Alternatively, [download the latest Git Graph ZIP](https://github.com/mattv8/openchamber-plugins/releases/latest/download/git-graph.zip) and select it in the Add dialog. Choose the **`git-graph.zip` asset**, not GitHub's “Source code” archive. ZIP installs do not retain a Git origin for branch-based updates. Both methods install the same precompiled package without building it on your machine.

[Tagged releases](https://github.com/mattv8/openchamber-plugins/releases) include checksums, source provenance, and version-specific downloads.

Allow the Git service and GitHub avatar origin on the extension's settings card. The service declares `git` and `gh`; avatars load from `https://avatars.githubusercontent.com`. Open Work Status to find **Git**. The section starts collapsed and appears only when a project is open.

- **Range and Refresh** sit in the section header. Manual mode lists branches to include in the body.
- **Hover** a commit to see its author, message, change counts and refs in a card beside the graph. The card offers Copy SHA, Open diff and, for GitHub remotes, Open on GitHub.
- **Click** a commit to list its changed files. A file opens the whole commit in OpenChamber's Diff view; per-file tabs need a host hook that does not exist yet.
- **Right-click** a commit, or press Shift+F10, for checkout, branch, tag, cherry-pick, revert, merge, rebase and reset. Each action shows the current branch and uncommitted changes before it runs. If the card closes while Git is running, the section reports the outcome when it can and never repeats the operation.

Graph colors follow the theme's syntax colors, matching the original. Range choices are saved per repository on this device.

For GitHub remotes, hover cards look up the commit author through the GitHub CLI (`gh`) using its existing login. If the CLI is missing or unauthenticated, the service tries GitHub's public API, which cannot read private repositories and has a lower rate limit. Lookups are cached; unavailable authors and failed images keep the initials fallback. The plugin never reads or displays the CLI's token. Local commit messages, statistics and changed files remain available independently of GitHub.

Extensions are supported in OpenChamber web and desktop. VS Code and mobile do not load this plugin.

## SDK input

The plugin uses the published `@openchamber/sdk@2.1.1` package: `setHeight`, `openCommit`, status-section header controls, device-scoped storage, syntax theme tokens and anchored popovers.
