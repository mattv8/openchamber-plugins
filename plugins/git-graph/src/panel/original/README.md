# Original graph source provenance

`gitGraph.ts`, `GitGraphSegment.tsx`, and `gitRefBadges.ts` are faithful ports
of OpenChamber PR #3008 at commit
`5186bb6b17e6c5ebc1ade97bfd000d858d8e4d92`.

The copied graph sources retain their Microsoft copyright and MIT license
notice. Local changes are limited to ESM `.js` import specifiers, aliases from
`GraphCommit`/`GraphRef` to `GitHistoryItem`/`GitHistoryRef`, and the local
icon-name union required outside the host icon module.

`CompactHistoryRow.tsx` extracts the compact branch of the PR's
`HistoryCommitRow.tsx`, preserving its 22px row, subject, grouped reference
badges, and author column. `GitGraphControls.tsx` adapts the original controls
to props supplied by the extension. CSS replaces host-only utility classes.
The extension uses local SVG icons because the host's icon sprite is not
available inside the guest frame.

The original graph geometry and deterministic color assignment are retained.
The SDK does not expose the original syntax palette, so the five graph color
variables currently use available host theme tokens. The original cross-panel
popover, section-header controls, and native workspace integration are deferred.
See [Git Graph agent guidance](../../../../../.agents/git-graph.md).

## Strict TypeScript compatibility

The plugin enables `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
The port therefore makes only these typing-preserving adjustments:

- `GitHistoryGraphRef.color`, `GitHistoryGraphItem.displayId`, and
  `GitHistoryGraphItem.references` explicitly admit `undefined`, matching the
  original graph's synthetic-item and badge construction.
- Indexed reads whose bounds are established immediately beside them use `!`
  with a `SAFETY` comment. The incoming/outgoing lookup additionally binds the
  already-validated view models to local constants; it does not change graph
  ordering or mutation.
- The copied badge test omits an absent optional `color` field. The graph test
  uses a checked `fixtureItem` helper for literal fixture positions, retaining
  the original values and assertions.
