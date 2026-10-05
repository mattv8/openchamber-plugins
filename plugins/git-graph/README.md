# Git Graph plugin

An installable Work Status Git graph for OpenChamber, restoring the compact graph, header controls and commit hover card from PR #3008. The original native combined workspace awaits additional host hooks.

The browser panel never invokes Git directly. It calls the plugin-owned loopback service using the versioned schemas exported from `src/shared/protocol.ts`. The service must validate every request, serialize writes per common Git directory, and reconcile a timed-out mutation before retrying it.

`bun run build -- git-graph` creates the panel IIFE, status-section HTML, CSS, Node service, and release manifest. `bun run package -- git-graph` produces `artifacts/git-graph/git-graph.zip` and `SHA256SUMS`.

The release package root has a real `package.json` with an official v2 manifest. It requires OpenChamber `>=2.1.1` and contributes only a Git status section. It adds no rail panel or standalone page.

## Install

[Download the latest Git Graph ZIP](https://github.com/mattv8/openchamber-plugins/releases/latest/download/git-graph.zip), then choose Settings → Extensions → Add in OpenChamber and select the archive. OpenChamber installs the precompiled package. It does not build the plugin during installation.

[Tagged releases](https://github.com/mattv8/openchamber-plugins/releases) include checksums, source provenance, and version-specific downloads.

Allow the Git service on the extension's settings card. Open Work Status to find **Git**. The section starts collapsed and appears only when a project is open.

- **Range and Refresh** sit in the section header. Manual mode lists branches to include in the body.
- **Hover** a commit to see its author, message, change counts and refs in a card beside the graph. The card offers Copy SHA, Open diff and, for GitHub remotes, Open on GitHub.
- **Click** a commit to list its changed files. A file opens the whole commit in OpenChamber's Diff view; per-file tabs need a host hook that does not exist yet.
- **Right-click** a commit, or press Shift+F10, for checkout, branch, tag, cherry-pick, revert, merge, rebase and reset. Each action shows the current branch and uncommitted changes before it runs. If the card closes while Git is running, the section reports the outcome when it can and never repeats the operation.

Graph colors follow the theme's syntax colors, matching the original. Range choices are saved per repository on this device.

Extensions are supported in OpenChamber web and desktop. VS Code and mobile do not load this plugin.

## SDK input

The plugin uses the published `@openchamber/sdk@2.1.1` package: `setHeight`, `openCommit`, status-section header controls, device-scoped storage, syntax theme tokens and anchored popovers.
