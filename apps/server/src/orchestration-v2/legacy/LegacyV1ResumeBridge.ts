import {
  CommandId,
  MessageId,
  ModelSelection,
  ProviderInstanceId,
  ProviderThreadId,
  type ServerSettings,
  ThreadId,
  defaultInstanceIdForDriver,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerSettingsService from "../../serverSettings.ts";
import * as CommandReceiptStore from "../CommandReceiptStore.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectStore from "../ProjectStore.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { decodeLegacyV1ResumeCursor } from "./LegacyV1ResumeCursor.ts";
import * as LegacyV1ThreadImporter from "./LegacyV1ThreadImporter.ts";

const CONTINUATION_TEXT = "Continue where you left off.";

interface PendingBridgeRow {
  readonly thread_id: string;
  readonly source_runtime_json: string;
  readonly source_session_status: string | null;
  readonly source_model_selection_json: string;
  readonly provider_thread_id: string | null;
}

const SourceRuntime = Schema.Struct({
  providerName: Schema.String,
  providerInstanceId: Schema.NullOr(Schema.String),
  resumeCursor: Schema.Unknown,
});
const decodeSourceRuntime = Schema.decodeUnknownOption(Schema.fromJsonString(SourceRuntime));
const decodeSourceSelection = Schema.decodeUnknownOption(Schema.fromJsonString(ModelSelection));

type Outcome =
  | { readonly status: "submitted" }
  | { readonly status: "skipped"; readonly reason: string };
type NativeOwners = Map<
  string,
  Array<{ readonly threadId: string; readonly instanceId: ProviderInstanceId }>
>;
const submitted: Outcome = { status: "submitted" };
const skip = (reason: string): Outcome => ({ status: "skipped", reason });

export interface LegacyV1ResumeBridgeShape {
  /**
   * Continues, once, the threads V1 was running when the user upgraded and
   * records each decision in `fork_v1_resume_bridge`. Never fails: a thread
   * that errors stays pending for the next pass and the others still run.
   */
  readonly continuePending: Effect.Effect<void>;
}

export class LegacyV1ResumeBridge extends Context.Service<
  LegacyV1ResumeBridge,
  LegacyV1ResumeBridgeShape
>()("t3/orchestration-v2/legacy/LegacyV1ResumeBridge") {}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettingsService.ServerSettingsService;
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;

  const record = (threadId: string, outcome: Outcome) =>
    sql`
      UPDATE fork_v1_resume_bridge
      SET continuation_status = ${outcome.status},
        reason = ${outcome.status === "skipped" ? outcome.reason : null}
      WHERE thread_id = ${threadId} AND continuation_status = 'pending'
    `;

  /**
   * Threads whose bound native session another thread also names. Resuming
   * one session from two threads would interleave their histories, so neither
   * is continued automatically.
   */
  const readNativeOwners = sql<{
    readonly thread_id: string;
    readonly source_runtime_json: string;
  }>`
    SELECT thread_id, source_runtime_json FROM fork_v1_resume_bridge
    WHERE binding_status = 'bound'
  `.pipe(
    Effect.map((rows) => {
      const owners: NativeOwners = new Map();
      for (const row of rows) {
        const source = decodeSourceRuntime(row.source_runtime_json);
        if (Option.isNone(source)) continue;
        const native = decodeLegacyV1ResumeCursor(
          source.value.providerName,
          source.value.resumeCursor,
        );
        if (Result.isFailure(native)) continue;
        const key = `${native.success.driver}\0${native.success.nativeId}`;
        const entry = {
          threadId: row.thread_id,
          instanceId:
            source.value.providerInstanceId === null
              ? defaultInstanceIdForDriver(native.success.driver)
              : ProviderInstanceId.make(source.value.providerInstanceId),
        };
        owners.set(key, [...(owners.get(key) ?? []), entry]);
      }
      return owners;
    }),
  );

  /** One thread, decided cheapest check first; transcripts are read only once it is eligible. */
  const continueLegacyV1Thread = (input: {
    readonly row: PendingBridgeRow;
    readonly settings: ServerSettings;
    readonly owners: NativeOwners;
    readonly continuationKey: (instanceId: ProviderInstanceId) => Effect.Effect<string | undefined>;
  }) =>
    Effect.gen(function* () {
      const { row } = input;
      const threadId = ThreadId.make(row.thread_id);
      const source = decodeSourceRuntime(row.source_runtime_json);
      const selection = decodeSourceSelection(row.source_model_selection_json);
      if (
        row.source_session_status !== "running" ||
        row.provider_thread_id === null ||
        Option.isNone(source) ||
        Option.isNone(selection)
      ) {
        return skip("not-running");
      }
      const native = decodeLegacyV1ResumeCursor(
        source.value.providerName,
        source.value.resumeCursor,
      );
      if (Result.isFailure(native)) return skip(native.failure);
      const { driver, nativeId } = native.success;
      const instanceId =
        source.value.providerInstanceId === null
          ? defaultInstanceIdForDriver(driver)
          : ProviderInstanceId.make(source.value.providerInstanceId);
      const providerThreadId = ProviderThreadId.make(row.provider_thread_id);

      // A server that stopped after the command committed but before this row
      // was updated finds the accepted receipt here, however much has run since.
      const commandId = CommandId.make(`command:migration:v1:continue:${row.thread_id}`);
      const receipt = yield* receipts.getByCommandId(commandId);
      if (Option.isSome(receipt)) {
        return receipt.value.status === "accepted" ? submitted : skip("command-rejected");
      }

      const current = yield* projections.getThreadRecords(threadId, ["runs"]);
      if (current.thread.archivedAt !== null || current.thread.deletedAt !== null) {
        return skip("thread-retired");
      }
      if (
        !resolveProjectSettings(input.settings, current.thread.projectId).settings
          .continueThreadsAfterServerUpdate
      ) {
        return skip("continuation-disabled");
      }
      if (Option.isNone(yield* projects.get(current.thread.projectId))) {
        return skip("project-deleted");
      }
      if (current.thread.activeProviderThreadId !== providerThreadId)
        return skip("binding-changed");
      if (
        current.thread.modelSelection.instanceId !== instanceId ||
        !modelSelectionsEqual(current.thread.modelSelection, selection.value)
      ) {
        return skip("selection-changed");
      }
      if (current.runs.length > 0) return skip("v2-run-exists");

      if (registry.getMetadata === undefined) return skip("instance-unavailable");
      const metadata = yield* registry.getMetadata(instanceId).pipe(Effect.option);
      if (Option.isNone(metadata) || !metadata.value.enabled) return skip("instance-unavailable");
      if (metadata.value.driver !== driver) return skip("driver-mismatch");

      const sharers = (input.owners.get(`${driver}\0${nativeId}`) ?? []).filter(
        (owner) => owner.threadId !== row.thread_id,
      );
      if (sharers.length > 0) {
        const key = metadata.value.continuationKey;
        for (const owner of sharers) {
          // Instances that share a provider home share its sessions. An instance
          // that cannot be resolved is assumed to.
          const ownerKey =
            owner.instanceId === instanceId
              ? key
              : yield* input
                  .continuationKey(owner.instanceId)
                  .pipe(Effect.orElseSucceed(() => undefined));
          if (ownerKey === undefined || ownerKey === key) return skip("shared-native-session");
        }
      }

      yield* importer.ensureTranscript(threadId);
      const result = yield* orchestrator.dispatchLegacyV1Continuation({
        command: {
          type: "message.dispatch",
          commandId,
          messageId: MessageId.make(`message:migration:v1:continue:${row.thread_id}`),
          threadId,
          text: CONTINUATION_TEXT,
          attachments: [],
          modelSelection: selection.value,
          dispatchMode: { type: "start_immediately" },
          createdBy: "agent",
          creationSource: "server",
        },
        expectedProviderThreadId: providerThreadId,
      });
      return result.outcome === "submitted" ? submitted : skip(result.reason ?? "not-eligible");
    });

  const continuePending = Effect.gen(function* () {
    const rows = yield* sql<PendingBridgeRow>`
      SELECT thread_id, source_runtime_json, source_session_status, source_model_selection_json,
        provider_thread_id
      FROM fork_v1_resume_bridge
      WHERE continuation_status = 'pending' AND binding_status = 'bound'
      ORDER BY thread_id ASC
    `;
    if (rows.length === 0) return;
    // Unreadable settings decide nothing: the rows stay pending for the next start.
    const settings = yield* serverSettings.getSettings;
    const owners = yield* readNativeOwners;
    const continuationKeys = new Map<ProviderInstanceId, Effect.Effect<string | undefined>>();
    const continuationKey = (instanceId: ProviderInstanceId) => {
      const known = continuationKeys.get(instanceId);
      if (known !== undefined) return known;
      const lookup = Effect.suspend(() =>
        registry.getMetadata === undefined
          ? Effect.succeed(undefined)
          : registry.getMetadata(instanceId).pipe(
              Effect.map((metadata) => metadata.continuationKey),
              Effect.orElseSucceed(() => undefined),
            ),
      );
      continuationKeys.set(instanceId, lookup);
      return lookup;
    };

    for (const row of rows) {
      yield* continueLegacyV1Thread({ row, settings, owners, continuationKey }).pipe(
        Effect.flatMap((outcome) => record(row.thread_id, outcome)),
        Effect.catchTags({
          OrchestratorCommandRejectedError: () =>
            record(row.thread_id, skip("command-rejected")).pipe(Effect.asVoid),
          OrchestratorCommandPreviouslyRejectedError: () =>
            record(row.thread_id, skip("command-rejected")).pipe(Effect.asVoid),
        }),
        // Interruption is a stop, not a failure of this thread: it stays pending.
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("V1 continuation left pending", {
                threadId: row.thread_id,
                cause: Cause.pretty(cause),
              }),
        ),
        Effect.asVoid,
      );
      yield* Effect.yieldNow;
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("V1 continuation pass stopped", { cause: Cause.pretty(cause) }),
    ),
  );

  return LegacyV1ResumeBridge.of({ continuePending });
});

export const layer: Layer.Layer<
  LegacyV1ResumeBridge,
  never,
  | SqlClient.SqlClient
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | Orchestrator.OrchestratorV2
  | ProjectionStore.ProjectionStoreV2
  | ProjectStore.ProjectStoreV2
  | CommandReceiptStore.CommandReceiptStoreV2
  | ServerSettingsService.ServerSettingsService
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
> = Layer.effect(LegacyV1ResumeBridge, make);
