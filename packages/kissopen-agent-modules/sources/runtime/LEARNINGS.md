# Runtime learnings

## Objective execution shares one persistent allowance

The human requested autonomous execution from a single stated objective. Runtime now composes
Tasks and Goal before constructing AutonomyBudget and gives Goal its History and Durable Functions
dependencies. Every path therefore uses the same goal identity, verification state, waits, and
lifetime allowance; ordinary human-turn resets continue to apply only to non-goal conversations.

## Expert routing belongs in both submission paths

Compose ExpertModule before KissopenModule, supplying bounded HistoryModule access and passing
the expert module into personal and team relay connections. The desktop API reuses the relay's
public preparation seam, so admission-time routing is identical across surfaces.

## Module loading belongs in distributed traces

Module timing logs alone did not reveal startup and restoration in the trace viewer. The shared
module wrapper now creates spans for initialization and ordinary hooks, including after-start and
agent restoration, passing the span context into module work so child spans nest correctly. It
preserves synchronous returns, asynchronous completion, and original failures. Raw provider events
remain uninstrumented so streaming deltas cannot flood telemetry.

## Probe startup is not the database responsiveness deadline

The isolated database deadlock test previously allowed four seconds for cold TypeScript imports,
database setup, and its gated tool batch. Under CI CPU contention, startup took over six seconds
even though the database check completed in under 110 milliseconds. The probe now has a separate,
bounded fifteen-second startup allowance. Its one-second deadline after `READY` and every
concurrency assertion remain unchanged, so slow process startup cannot masquerade as a deadlock.

## Shared event streams do not reserve the next frame for one feature

The team mobile-connection test assumed its next event frame was a connection update. An
asynchronous slash-command catalog update legitimately arrived first and failed release checks.
The test now waits for the next integration event while skipping only unrelated event types,
with explicit time and frame-count bounds. It must not filter by the expected member, version,
or payload: the first integration event is still compared exactly, so another member's leaked
connection state cannot be skipped. Real profile updates force unrelated events ahead of both
replayed and live connection updates, making the ordering regression deterministic.

## Integration fixtures must share canonical workspace paths

On macOS, temporary folders under `/var` resolve to `/private/var`. Projects canonicalize their
managed roots, so fixtures that manually compose compute contexts or assert archival paths must
canonicalize the temporary root first. Keep the cached-compute cwd invariant and service cleanup
assertions intact; an alias in a fixture is not a reason to relax those runtime protections.
