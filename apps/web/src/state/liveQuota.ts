/**
 * Multi-environment live quota state.
 *
 * Live quota is a point-in-time read of a provider's own dashboard/rate-limit
 * API (Cursor's billing-cycle usage, Anthropic's rolling 5h/7d window) —
 * distinct from {@link "./usage.ts" | the historical transcript-scan usage}
 * the page already has.
 *
 * Unlike usage, live quota is account-level, not additive: connecting a
 * second environment does not mean "add more tokens", it means "here is
 * another possible answer for the same provider" — and that answer may
 * legitimately belong to a *different* account than the first environment's.
 * See {@link mergeLiveQuota} for the dedupe rule this implies.
 *
 * @module state/liveQuota
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, LiveQuotaResult } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentLiveQuotaStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly results: readonly LiveQuotaResult[] | null;
}

/**
 * One environment's answer, as consumed by {@link mergeLiveQuota}. A thinner
 * shape than {@link EnvironmentLiveQuotaStatus} so the merge stays a pure
 * function of "who said what", independent of pending/error presentation.
 */
export interface EnvironmentLiveQuotaAnswer {
  readonly environmentId: EnvironmentId;
  readonly results: readonly LiveQuotaResult[];
}

/**
 * Every connected environment answers the same query, so the client must
 * merge them the way it does for usage — but "first ok result per provider"
 * is the wrong rule here. Two connected environments can hold genuinely
 * different authenticated accounts for the same provider (two machines, two
 * Cursor logins); picking one arbitrarily would make the card silently flip
 * accounts depending on connection order.
 *
 * Instead, results are deduped by `(provider, accountEmail)`: usually still
 * one card per provider, but when accounts genuinely differ, both render.
 *
 * `accountEmail: null` is a real, expected case — it's a best-effort field
 * server-side (Claude's live-quota result in particular may not have one)
 * — and must NOT be used as a dedupe key on its own: two `null`-email
 * results collapsing into one card would silently reintroduce the exact
 * "wrong account" bug this rule exists to avoid. When `accountEmail` is
 * `null`, results are deduped by `(provider, environmentId)` instead, so
 * every connected environment still gets its own card.
 *
 * The first environment to report a given key wins; environments are not
 * pre-sorted, so which one that is is whatever order the caller supplies
 * (stable within a render, since it derives from the same atom read).
 */
export function mergeLiveQuota(
  environments: readonly EnvironmentLiveQuotaAnswer[],
): readonly LiveQuotaResult[] {
  const seen = new Map<string, LiveQuotaResult>();
  for (const environment of environments) {
    for (const result of environment.results) {
      const key =
        result.accountEmail !== null
          ? `${result.provider}:email:${result.accountEmail}`
          : `${result.provider}:env:${environment.environmentId}`;
      if (!seen.has(key)) {
        seen.set(key, result);
      }
    }
  }
  return [...seen.values()];
}

const liveQuotaAtom = Atom.make((get): readonly EnvironmentLiveQuotaStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);

  const statuses: EnvironmentLiveQuotaStatus[] = [];
  for (const [environmentId, presentation] of presentations) {
    const result = get(serverEnvironment.liveQuota({ environmentId, input: {} }));
    statuses.push({
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not report live quota." : null,
      results: Option.getOrNull(AsyncResult.value(result)),
    });
  }
  return statuses;
}).pipe(Atom.withLabel("web-live-quota:all"));

export interface LiveQuotaView {
  readonly results: readonly LiveQuotaResult[];
  readonly environments: readonly EnvironmentLiveQuotaStatus[];
  /** True until at least one environment has answered. */
  readonly isPending: boolean;
  /**
   * True while environments that have not failed are still answering. Mirrors
   * {@link "./usage.ts" | UsageView}'s `isPartial`.
   */
  readonly isPartial: boolean;
  readonly refresh: () => void;
}

export function useLiveQuota(): LiveQuotaView {
  const environments = useAtomValue(liveQuotaAtom);

  // As in useUsage: refreshing only the derived atom would re-read each
  // environment's SWR query within its stale window and change nothing.
  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.liveQuota({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);

  const results = useMemo(
    () =>
      mergeLiveQuota(
        environments.flatMap((environment) =>
          environment.results === null
            ? []
            : [{ environmentId: environment.environmentId, results: environment.results }],
        ),
      ),
    [environments],
  );

  const answeredCount = environments.filter((environment) => environment.results !== null).length;
  const stillReporting = environments.filter(
    (environment) => environment.results === null && environment.error === null,
  ).length;

  return {
    results,
    environments,
    isPending: answeredCount === 0 && stillReporting > 0,
    isPartial: answeredCount > 0 && stillReporting > 0,
    refresh,
  };
}
