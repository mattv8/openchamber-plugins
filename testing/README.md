# Isolated host testing

`bun run test:app:stock` launches a real web host, installs a packed plugin through the public guest-upload API, creates an isolated Git fixture, and inspects the Work Status graph in Playwright. It checks that the package adds no rail panel or page. `test:app:electron` never substitutes web coverage for the native shell.

`bun run test:browser` exercises the status component and retained mutation guards in isolated browser fixtures. Mutation tests cover service/workspace mechanics; they do not claim that the original native combined workspace is integrated.

The web commands require `OPENCHAMBER_HOST_SOURCE`, `OPENCHAMBER_PLUGIN_ZIP`, and `OPENCHAMBER_TEST_OPENCODE_BINARY`. They create temporary `HOME`, XDG, OpenChamber, OpenCode, and Electron user-data roots, then remove them along with the fixture and child process tree.

The supplied host source must already have `packages/web/dist/index.html` from its documented build. The browser test refuses to treat the server's “Static files not found” page as app coverage. `test:app:electron` checks for the selected host's unpackaged Electron binary. It exits as unavailable when the binary is absent and remains blocked until the native-shell inspection runner is reviewed.

`hosts.lock.json` is authoritative. The host must be at the exact official upstream revision. A fork checkout is accepted only when its `upstream` remote is the official repository at that revision.
