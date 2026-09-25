# OpenChamber plugins

This repository contains independently installable OpenChamber plugins. It is not itself an installable plugin.

## Packages

- `plugins/git-graph`: Work Status Git graph. Its service owns local Git access. The original native combined workspace and cross-panel popover await host integration hooks.

## Development

Run `bun install`, then use `bun run check` and `bun test`. Build the plugin with `bun run build -- git-graph`; package it with `bun run package -- git-graph`.

For the browser regression tests, install Chromium with `bunx playwright install chromium`, then run `bun run test:browser`. They cover status-section recovery and repository-scoped mutation guards.

Release archives have a plugin `package.json` at their ZIP root plus precompiled assets. They never build during installation.

The release archive is `artifacts/git-graph/git-graph.zip`. It uses the published `@openchamber/sdk@2.0.1` contract and requires OpenChamber 2.0.1 or later.

See [SDK integration gaps](docs/sdk-integration-gaps.md) for the maintainer handoff and the features deferred until those hooks exist. The package does not add a separate rail button or extension page.
