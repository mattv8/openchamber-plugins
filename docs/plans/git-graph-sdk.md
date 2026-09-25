# Approved Git Graph SDK plan

The implementation is an independently installable plugin using the published v2 SDK. The plugin owns Git access; it does not import host-private Git routes, state, or credentials.

The package ships one v2 archive, a service-owned Git mutation queue, bounded protocol transport, and precompiled assets. Browser regression tests cover status-section recovery and repository-scoped mutation guards; the isolated-host runner checks the installed package against the pinned upstream source.

The release floor is OpenChamber `2.0.1`. The host test is pinned to upstream commit `ffa12ea39b00c0fe1f2b9c9f56b7aefc6ff3fcce`. The manifest uses the published `@openchamber/sdk@2.0.1` status-section contract.

The required interface is the original PR #3008 implementation, not the earlier replacement UI. Deliver the supported status graph without a new rail button or page. Defer the native combined workspace and cross-panel popover, preserving those requirements until the host hooks described in [SDK integration gaps](../sdk-integration-gaps.md) exist.
