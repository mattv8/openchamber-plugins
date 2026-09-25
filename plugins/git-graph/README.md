# Git Graph plugin

An installable Work Status Git graph for OpenChamber, restoring the compact graph from PR #3008. The original native combined workspace and cross-panel commit popover await additional host hooks.

The browser panel never invokes Git directly. It calls the plugin-owned loopback service using the versioned schemas exported from `src/shared/protocol.ts`. The service must validate every request, serialize writes per common Git directory, and reconcile a timed-out mutation before retrying it.

`bun run build -- git-graph` creates the panel IIFE, status-section HTML, CSS, Node service, and release manifest. `bun run package -- git-graph` produces `artifacts/git-graph/git-graph.zip` and `SHA256SUMS`.

The release package root has a real `package.json` with an official v2 manifest. It requires OpenChamber `>=2.0.1` and contributes only a Git status section. It adds no rail panel or standalone page.

## Install

Build or download `git-graph.zip`, then choose Settings → Extensions → Add in OpenChamber and select the archive. OpenChamber installs the precompiled package. It does not build the plugin during installation.

Allow the Git service on the extension's settings card. Open Work Status to find **Git**. The section provides auto/all/manual history filters. The native workspace and floating commit popover are deferred rather than replaced with a different interface.

Extensions are supported in OpenChamber web and desktop. VS Code and mobile do not load this plugin.

## SDK input

The plugin uses the published `@openchamber/sdk@2.0.1` package. The status section calls the official `setHeight` and `openCommit` host APIs.
