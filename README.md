# OpenChamber plugins

This repository contains independently installable OpenChamber plugins. `main` contains their source; the `git-graph` branch contains the prebuilt, installable Git Graph package.

## Download

| Plugin | Download | Requirements |
| --- | --- | --- |
| [Git Graph](plugins/git-graph) | [Latest ZIP](https://github.com/mattv8/openchamber-plugins/releases/latest/download/git-graph.zip) · [All releases](https://github.com/mattv8/openchamber-plugins/releases) | OpenChamber 2.1.1+ |

## Install with update checks

In OpenChamber, choose **Settings → Extensions → Add** and enter this Git URL:

```text
https://github.com/mattv8/openchamber-plugins.git#git-graph
```

Keep the `#git-graph` suffix: it selects the prebuilt plugin branch. The bare repository URL selects `main`, whose workspace `package.json` is not an extension and produces “package.json is invalid.”

Approve the Git service and GitHub avatar origin, then open **Work Status → Git** in a project. OpenChamber remembers the Git URL and branch for update checks; use the extension's update controls to apply a newer version. Updates are not installed automatically in the background.

For a ZIP install, select the **`git-graph.zip` release asset** in the same Add dialog. Do not use GitHub's “Source code” archives. ZIP installs do not retain a Git origin for branch-based updates.

Git Graph provides the Work Status graph with header range controls, commit hover cards, inline changed-file lists and a commit action menu. The original native combined workspace still awaits host integration hooks.

## Releases

Changes to plugin code or build inputs on `main` automatically run verification, build the ZIP, test it in the pinned OpenChamber host, and publish a tagged GitHub release. The first Git Graph release uses the package's starting version; later releases automatically increment the patch version. Raising the source package version sets a new minimum for a minor or major release.

Tags use `git-graph/vX.Y.Z`. Each release includes `git-graph.zip`, a SHA-256 checksum, build provenance, and release notes. After publication, the same verified ZIP contents are committed to the `git-graph` distribution branch. That branch is updated only after the release checks pass; it never builds on the user's machine. The ZIP download above follows the latest published release. Documentation-only changes do not increment the plugin version.

## Development

Run `bun install`, then use `bun run check` and `bun test`. Build the plugin with `bun run build -- git-graph`; package it with `bun run package -- git-graph`.

For the browser regression tests, install Chromium with `bunx playwright install chromium`, then run `bun run test:browser`. They cover status-section recovery and repository-scoped mutation guards.

Release archives have a plugin `package.json` at their ZIP root plus precompiled assets. They never build during installation.

The release archive is `artifacts/git-graph/git-graph.zip`. It uses the published `@openchamber/sdk@2.1.1` contract and requires OpenChamber 2.1.1 or later.

Repository-specific agent guidance lives in [`.agents/`](.agents/). Historical plans and feature evidence are local, ignored scratch under `.opencode/`.
