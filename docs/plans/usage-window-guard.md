# Plan: usage-window guard, resume after recovery, cache banner, context estimates

Branch: `nix-quota-mobile-cursor-output-compact-resume-cache`, rebuilt on fresh `main`.
The branch name is the full scope: it carries this fork's **mobile** changes, **Cursor**
adapter updates, **agent output** updates, and the branch's **liveQuota** service
(Claude + Cursor + OpenAI providers, `LiveQuotaCards`), which main's Limits tab
(#9507) does not cover — Cursor and Codex-rate-limit data in particular.

## What upstream already has

- **#9507 (merged)** — Limits tab; normalizes provider rate limits into
  `ServerProvider.usageLimits` (`session`/`weekly`/`monthly`/`other` windows with
  `usedPercent`, `resetsAt`) and streams snapshots to every client.
- **#8144 (merged)** — compact old threads before they burn through usage window.

Everything else below is not implemented upstream; the listed PRs are ideas to
integrate, adapted to this branch.

## Upstream PR integration (in dependency order)

| PR | State | What it does | Integration decision |
| --- | --- | --- | --- |
| #10095 | open | Enforce configurable thread context limits; server gate before workspace prep | Cherry-pick, adapted: **global** setting, default **250k** (per-provider later if wanted) |
| #10962 | open | `compacting` runtime session state (Claude auto-compaction renders as Compacting, not Thinking) | Cherry-pick, then **wire Codex (`contextCompaction` started) and OpenCode (`session.time.compacting`) signals** the PR left unwired |
| #10550 | open | Show a usage-limit stop as **Limited** (warning tone) instead of **Failed** | Cherry-pick; supplies the `usage_limit` error class the guard's error trigger reads |
| #9012 | open | Snooze a thread until provider limits reset (composer notice + snooze menus) | Cherry-pick; its composer notice shares the banner stack slot with the cache banner |
| #8857 | open | Generate and preserve thread handover drafts when the context limit hits | Cherry-pick, adapted; simplest thing that reaches the same end goal (see #10097 note) |
| #10097 | open | Reserve shared slots for concurrent provider work | Decision deferred: "do whatever's simplest while maintaining the desired end goal for #8857 and #10097" |
| #8577 | closed | Resume threads after usage limits reset | **Adapted, not picked** — replaced by the guard below; its reusable pieces: native limit-error classification per provider, persisted scheduled state, safe cancellation |

Upstream's #10550 and #10962 both add migration `050`; renumber ours in pick
order (latest here is `050_ProjectionThreadPullRequests`, so picks start at `051`).

## The guard (replaces #8577's approach)

Verbatim intent: after every model request, look at the usage limit of that
provider. Once the limit is 90% reached, prompt the user to consider waiting or
compacting. If the user presses "don't compact, keep going", disable all limits
and let the user's unlimited usage kick in (if they have it). Otherwise, at 95%,
stop the thread, compact it, and keep the thread paused. Once the limit resets
(add a 5h max resume time limit; weekly limits don't resume), resume that
thread. Inform the model how much time has passed and let the model decide
whether its work is still relevant prior to jumping back in; if it decides it
isn't, it ends its turn explaining the perceived blocker.

Concrete rules:

- **Thresholds hardcoded**: 90% prompt, 95% act. No settings UI for them.
- **Preemptive trigger**: after each model request (turn boundary), read the
  provider's usageLimits snapshot (server-side).
  - ≥90% (once per window): composer prompt — wait or compact. Choosing
    "don't compact, keep going" sets a suppression flag for that window (until
    reset) that disables both thresholds for the thread.
  - ≥95%: stop the thread, run a compaction, and leave the thread paused
    (snoozed) until the window resets.
- **Provider-error trigger**: native usage-limit errors classified per adapter
  (#8577's classification work + #10550's `usage_limit` class). The preemptive
  path only works where providers publish windows (Claude, Codex); Cursor, Grok,
  OpenCode need the error path. Both triggers land in the same settlement:
  mark the thread `Limited`, offer/perform compact-at-95%, schedule resume.
- **Resume scheduling**: reset time from the provider window when present; cap
  at 5h (`min(resetsAt, now + 5h)`); weekly windows do not auto-resume. Persist
  the schedule so restarts and reconnects survive; cancel on user action
  (#9012's snooze is visibility-only and stays that way — the guard's resume is
  separate). On resume, prepend a continuation system note: how long the thread
  waited and that the model should decide whether its prior work is still
  relevant; if not, end the turn with the perceived blocker instead of
  continuing blind.
- Surfacing reuses what upstream has: `Limited` row status (#10550), snooze
  menus (#9012), the Limits tab (#9507), and live quota cards from this branch.

## Cache status banner

- Providers: Claude and Codex only (the ones whose caches we can see). 5-minute
  freshness from the provider, matching Claude's prompt-cache TTL.
- Copy, exact: `This thread is cached for the next n minutes.` and
  `This thread is uncached at <n>k tokens.`; above ~100k uncached tokens append
  `Consider starting a new thread.`
- Renders in the composer banner stack slot shared with #9012's usage-limit
  notice (one banner at a time; limit notice wins).
- Fed by thread token tracking (below), not a new provider call.

## Context usage estimates

- Persisted per-thread token tracking; numbers shown as **estimated** where the
  provider does not report a count.
- Base: last compaction's reported context + `chars/4` for providers without
  token accounting (Cursor, Grok, OpenCode).
- The context meter stays **opt-in** (off by default), matching the existing
  usage-meter setting.

## Working rules

- Surfaces: contracts → server → client-runtime → web + mobile + desktop. Hit
  every provider adapter even when the decision is "not supported here".
- Migrations renumbered in pick order; one concern per commit.
- Verification: scoped tests for changed files, scoped typechecks per package.
  No repo-wide checks; no browser verification without explicit approval.