# Git Graph architecture

The Git Graph package has three boundaries:

1. The status-section bundle is a React IIFE running in an opaque guest frame.
2. The Node ESM service runs with the user's OS permissions and owns Git operations.
3. `src/shared/protocol.ts` is the single Zod-validated JSON contract between them.

The host supplies directory context only through its approved SDK bridge. A guest never uses that context as an authorization claim. Reads carry repository and snapshot identifiers. Mutations additionally carry a client-generated operation ID and expected snapshot; the service deduplicates the ID, detects stale state, and returns an unknown outcome after an unrecoverable timeout rather than automatically writing again.

Ref reads use snapshot-bound cursors, at most 200 refs per page, and a 200 KB JSON budget within the SDK's 256 KB response limit. The browser adapter collects the complete ref set before exposing it to the graph. A later page failure fails the whole read; partial refs never become authoritative. The adapter rejects a repeating cursor or more than 10,000 refs. Internal ref metadata and snapshot commands have separate 8 MiB limits; ordinary Git output remains capped at 240 KB.

The official v2 manifest declares a service and a Git status section, with panel metadata but no panel entry or page. The frame calls the published SDK's `setHeight` and `openCommit` APIs. Original graph code comes from PR #3008; host-specific dependencies are adapted at the extension boundary.

The native combined workspace and cross-panel popover are deferred until the host exposes the required integration points. See [SDK integration gaps](../sdk-integration-gaps.md). The existing standalone workspace code is retained for its service and mutation regression coverage, but it is not an exposed replacement UI.
