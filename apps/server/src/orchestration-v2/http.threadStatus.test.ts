import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type AuthEnvironmentScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as OrchestrationEventStore from "../persistence/Services/OrchestrationEventStore.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import { orchestrationHttpApiLayer } from "./http.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

class OrchestrationTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postStatus = (threadId: string, body: unknown) =>
  new Request(`http://127.0.0.1/api/orchestration/threads/${threadId}/status`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeJson(body),
  });

const status = {
  source: "usagewindow",
  key: "compacting",
  text: "Compacting",
  icon: "shrink",
  color: "amber",
  notifyUser: true,
  expiresAt: "2099-09-22T12:00:00.000Z",
  clearsOn: "work",
  updatedAt: "2026-09-22T11:55:00.000Z",
} as const;

/**
 * Serves only the orchestration group over an in-process handler. The thread
 * management service is the seam the endpoint dispatches through, so a
 * recording mock observes exactly the command the server would run.
 */
const withStatusApi = <A>(
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  run: (api: {
    readonly post: (threadId: string, body: unknown) => Promise<Response>;
    readonly dispatched: Array<OrchestrationV2ServerCommand>;
  }) => Promise<A>,
  options?: { readonly failDispatch?: boolean },
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
      effect.pipe(
        Effect.provideService(EnvironmentAuthenticatedPrincipal, {
          sessionId: AuthSessionId.make("thread-status-session"),
          subject: "usagewindow",
          method: "bearer-access-token",
          scopes: new Set(scopes),
        }),
      ),
    );
    const threadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: (command) => {
        if (options?.failDispatch) return Effect.die("dispatch failed");
        dispatched.push(command);
        return Effect.succeed({ sequence: 42, storedEvents: [] });
      },
    });
    const routes = HttpApiBuilder.layer(OrchestrationTestApi).pipe(
      Layer.provide(orchestrationHttpApiLayer),
      Layer.provide(auth),
      Layer.provide(threadManagement),
      Layer.provide(Layer.mock(SqlClient.SqlClient)({})),
      Layer.provide(Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({})),
      Layer.provide(Layer.mock(ProjectStore.ProjectStoreV2)({})),
      Layer.provide(Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({})),
      Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
      Layer.provideMerge(
        HttpPlatform.layer.pipe(
          Layer.provideMerge(NodeServices.layer),
          Layer.provideMerge(Etag.layerWeak),
        ),
      ),
    );
    const requestContext = Context.make(Crypto.Crypto, crypto);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
      (web) =>
        Effect.tryPromise(() =>
          run({
            post: (threadId, body) => web.handler(postStatus(threadId, body), requestContext),
            dispatched,
          }),
        ),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

it.effect("sets an external status through the operate-scoped endpoint", () =>
  withStatusApi([AuthOrchestrationOperateScope], async ({ post, dispatched }) => {
    const response = await post("thread-status-1", { status });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sequence: 42 });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.metadata.update",
      threadId: "thread-status-1",
      externalStatus: status,
    });
    expect(dispatched[0]?.commandId).toBeTruthy();
  }),
);

it.effect("clears the external status when the body status is null", () =>
  withStatusApi([AuthOrchestrationOperateScope], async ({ post, dispatched }) => {
    const response = await post("thread-status-2", { status: null });
    expect(response.status).toBe(200);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "thread.metadata.update",
      threadId: "thread-status-2",
      externalStatus: null,
    });
  }),
);

it.effect("keeps producers that omit clearsOn working by defaulting it to null", () =>
  withStatusApi([AuthOrchestrationOperateScope], async ({ post, dispatched }) => {
    const { clearsOn: _clearsOn, ...legacy } = status;
    const response = await post("thread-status-3", { status: legacy });
    expect(response.status).toBe(200);
    expect(dispatched[0]).toMatchObject({ externalStatus: { clearsOn: null, key: "compacting" } });
  }),
);

it.effect("requires the operate scope", () =>
  withStatusApi([AuthOrchestrationReadScope], async ({ post, dispatched }) => {
    const response = await post("thread-status-4", { status });
    expect(response.status).toBe(403);
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("rejects malformed statuses without dispatching", () =>
  withStatusApi([AuthOrchestrationOperateScope], async ({ post, dispatched }) => {
    expect((await post("thread-status-5", { status })).status).toBe(200);
    dispatched.length = 0;
    expect(
      (await post("thread-status-5", { status: { ...status, clearsOn: "bogus" } })).status,
    ).toBe(400);
    expect((await post("thread-status-5", {})).status).toBe(400);
    expect(dispatched).toHaveLength(0);
  }),
);

it.effect("reports a failed dispatch as a server error", () =>
  withStatusApi(
    [AuthOrchestrationOperateScope],
    async ({ post }) => {
      expect((await post("thread-status-6", { status })).status).toBe(500);
    },
    { failDispatch: true },
  ),
);
