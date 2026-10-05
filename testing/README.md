# Isolated host testing

`bun run test:app:stock` launches a real web host, installs a packed plugin through the public guest-upload API, creates an isolated Git fixture, and inspects the Work Status graph in Playwright. It checks that the package adds no rail panel or page. `test:app:electron` launches the locked host's unpackaged Electron binary through Playwright `_electron`; it never substitutes web coverage for the native shell.

`bun run test:browser` exercises the status component and retained mutation guards in isolated browser fixtures. Mutation tests cover service/workspace mechanics; they do not claim that the original native combined workspace is integrated.

Both host commands require `OPENCHAMBER_HOST_SOURCE`, `OPENCHAMBER_PLUGIN_ZIP`, and `OPENCHAMBER_TEST_OPENCODE_BINARY`. They create temporary `HOME`, XDG, OpenChamber, OpenCode, and Electron user-data roots, then remove them along with the fixture and child processes.

The web test requires `packages/web/dist/index.html` from the host's documented build. It refuses to treat the server's “Static files not found” page as app coverage. Native verification uses the host's development entry at `packages/electron/entry.mjs` and its adjacent preload, matching `electron:dev:bundled`. Build its UI assets with `node packages/electron/scripts/build-web-assets.mjs` in the locked host checkout. The runner checks `packages/electron/resources/web-dist/index.html` and reports `UNAVAILABLE` when prerequisites are missing; it does not build host artifacts itself. The native path uses a fresh HOME, config, data, Electron user-data directory, fixture repository, and the test-local desktop runtime token discovered from the running Electron window; tokens are not logged.

`hosts.lock.json` is authoritative. The host must be at the exact official upstream revision. A fork checkout is accepted only when its `upstream` remote is the official repository at that revision.

Native startup loads an isolation hook before the host entry. It blocks OS-wide URL-handler and login-item registration, which temporary profile directories alone cannot isolate. Cleanup uses a test-local managed-process registry and verifies the recorded OpenCode processes have exited before removing the run directory. A cleanup failure preserves that directory for diagnosis.

Screenshots go to `.cache/evidence/web` and `.cache/evidence/electron`; the web run also records console and service logs. The native test currently verifies the unpackaged macOS shell with bundled UI; it does not verify signed installers or Windows/Linux shells.
