# OpenChamber plugins

This repository contains independently installable OpenChamber plugins. It is not itself an installable plugin.

## Download

| Plugin | Download | Requirements |
| --- | --- | --- |
| [Git Graph](plugins/git-graph) | [Latest ZIP](https://github.com/mattv8/openchamber-plugins/releases/latest/download/git-graph.zip) · [All releases](https://github.com/mattv8/openchamber-plugins/releases) | OpenChamber 2.0.1+ |

In OpenChamber, choose **Settings → Extensions → Add**, select the ZIP, and allow the Git service. The graph appears under **Work Status → Git**.

Git Graph currently provides the Work Status graph. The original native combined workspace and cross-panel popover await host integration hooks.

## Releases

Changes to plugin code or build inputs on `main` automatically run verification, build the ZIP, test it in the pinned OpenChamber host, and publish a tagged GitHub release. The first Git Graph release uses the package's starting version; later releases automatically increment the patch version. Raising the source package version sets a new minimum for a minor or major release.

Tags use `git-graph/vX.Y.Z`. Each release includes `git-graph.zip`, a SHA-256 checksum, build provenance, and release notes. The ZIP download above follows the latest published release. Documentation-only changes do not increment the plugin version.

## Development

Run `bun install`, then use `bun run check` and `bun test`. Build the plugin with `bun run build -- git-graph`; package it with `bun run package -- git-graph`.

For the browser regression tests, install Chromium with `bunx playwright install chromium`, then run `bun run test:browser`. They cover status-section recovery and repository-scoped mutation guards.

Release archives have a plugin `package.json` at their ZIP root plus precompiled assets. They never build during installation.

The release archive is `artifacts/git-graph/git-graph.zip`. It uses the published `@openchamber/sdk@2.0.1` contract and requires OpenChamber 2.0.1 or later.

Repository-specific agent guidance lives in [`.agents/`](.agents/). Historical plans and feature evidence are local, ignored scratch under `.opencode/`.
