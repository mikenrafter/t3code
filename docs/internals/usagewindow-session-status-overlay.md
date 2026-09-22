# Usagewindow session-status overlay

This is the implementation plan for the Usagewindow integration branch
`feature/usagewindow-session-status-overlay`. It is intentionally limited to
opening a generic T3 Code metadata hatch and rendering one external status
source. Usagewindow owns the quota policy and lifecycle decisions; T3 Code
stores and presents the resulting status without interpreting quota data.

## Goal

Allow an authenticated local or remote integration to attach a temporary,
user-visible status to a T3 Code thread/session. The first producer is
Usagewindow, with these initial statuses:

- `compacting` — a claimed compaction request was sent and completion has not
  been observed yet;
- `scheduled` — a resume or other Usagewindow action has a future scheduled
  time;
- `paused` — Usagewindow has intentionally deferred continuation, normally
  because a quota/window policy prevents safe continuation.

T3 Code's existing native `monitoring` presentation remains unchanged. This
  work does not rename or replace it with `watching`.

## Generic status shape

The external overlay is optional and namespaced by its producer. Its wire
shape should be equivalent to:

```ts
{
  source: string,
  key: string,
  text: string,
  icon: string,
  color: string,
  notifyUser: boolean,
  expiresAt: string | null,
  updatedAt: string
}
```

`source` and `key` make the hatch generic without requiring T3 Code to know
the producer's state vocabulary. `text`, `icon`, and `color` are presentation
inputs. `notifyUser` is a transition hint: clients may notify when the
overlay becomes active or changes, but must not repeat notifications on every
read-model refresh. `expiresAt` is a safety lease; expired overlays should be
treated as absent by clients and cleaned up by the server/read model.

The endpoint must be idempotent for the same `(threadId, source)` and should
support clearing the producer's overlay. A producer must not be able to mutate
native provider session fields, titles, messages, or another producer's
overlay.

## T3 Code work

1. Add the optional status to the orchestration thread and thread-shell
   contracts, with backward-compatible decoding for clients and servers that
   do not know the field.
2. Add persisted event/projector/read-model support for setting and clearing
   one producer's overlay. Preserve the event-sourced command/decider/
   projector boundary.
3. Add an authenticated generic HTTP endpoint for setting and clearing the
   overlay. It should resolve the thread/session, validate the shape and
   expiry, and emit the normal orchestration event rather than writing the
   projection directly.
4. Render the overlay as a secondary status pill in the web, desktop-wrapped
   web, and mobile thread surfaces. Native input/approval/error/working/
   monitoring/done behavior remains authoritative and keeps its existing
   precedence.
5. Implement notify-on-transition behavior using the overlay identity and
   `updatedAt`/event identity, with no repeated notification from polling or
   reconnects.
6. Add focused contract, server, expiry, authorization, and UI-logic tests.

The initial T3 Code API should expose only status mutation. No T3 Code UI for
authoring arbitrary statuses is needed in this phase.

## Usagewindow work

Usagewindow will use the endpoint after the T3 Code hatch exists. It will:

- map native provider session IDs to their owning T3 Code thread IDs using the
  existing ownership lookup;
- publish `compacting` after claim-before-act and clear it only after observed
  compaction completion or terminal failure;
- publish `scheduled` while a resume marker is pending/scheduled, including the
  resume time in `expiresAt` or the text/detail;
- publish `paused` while policy deliberately blocks continuation, with an
  expiry when the block is tied to a known quota reset;
- clear the overlay on cancellation, resume, user activity, or expiry;
- use stable icon/color choices from a small Usagewindow presentation map and
  set `notifyUser` only on meaningful transitions.

Usagewindow should fail closed if the owner mapping or authenticated T3 Code
endpoint is unavailable. The local Usagewindow state remains authoritative;
T3 Code is only a presentation/metadata consumer.

## State precedence

The overlay is secondary to T3 Code's actionable native states. The intended
combined presentation is approximately:

```text
needs input / approval > compacting > scheduled > working / monitoring > paused > ready / done
```

The exact visual treatment may vary by surface, but the overlay must never
hide a native request for user input, approval, or an error.

## Delivery phases

1. T3 Code: contract, persistence/event projection, authenticated generic
   mutation endpoint, and focused tests.
2. T3 Code: web/mobile rendering and transition notifications.
3. Usagewindow: client for the endpoint, native-session ownership mapping,
   status derivation, and transition tests.
4. Integrated verification with a disposable T3 Code thread and a synthetic
   Usagewindow schedule/compaction sequence.
