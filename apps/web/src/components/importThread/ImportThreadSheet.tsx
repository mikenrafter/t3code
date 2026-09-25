import { useAtomValue } from "@effect/atom-react";
import {
  ProviderDriverKind,
  type AgentSessionEntry,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Atom } from "effect/unstable/reactivity";
import { InboxIcon, LoaderCircleIcon, RefreshCwIcon, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "@tanstack/react-router";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { agentSessionAttach, agentSessionList } from "../../state/agentSessions";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../../threadRoutes";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { getDriverOption } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import {
  PAGE_LIMITS,
  computeImportThreadEmptyState,
  filterImportThreadEntries,
  importThreadEmptyStateMessage,
  nextPageLimit,
  providerLabel,
  resolveDefaultImportProject,
  type ProviderFilter,
} from "./importThreadSheet.logic";

export interface ImportThreadSheetRequest {
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
}

const importThreadSheetRequestAtom = Atom.make<ImportThreadSheetRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("import-thread:sheet-request"),
);

/** Open the Import thread sheet; optional scope seeds the project picker. */
export function openImportThreadSheet(request: ImportThreadSheetRequest = {}): void {
  appAtomRegistry.set(importThreadSheetRequestAtom, request);
}

export function ImportThreadSheetHost() {
  const request = useAtomValue(importThreadSheetRequestAtom);
  if (request === null) return null;
  return (
    <ImportThreadSheet
      open
      initialRequest={request}
      onOpenChange={(open) => {
        if (!open) appAtomRegistry.set(importThreadSheetRequestAtom, null);
      }}
    />
  );
}

function ImportThreadSheet({
  open,
  initialRequest,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly initialRequest: ImportThreadSheetRequest;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const projects = useProjects();
  const router = useRouter();
  const nowMinute = useNowMinute();
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const activeThread = useThreadShell(routeThreadRef);

  const preferredProject = useMemo(() => {
    if (initialRequest.projectId === undefined || initialRequest.environmentId === undefined) {
      return null;
    }
    return (
      projects.find(
        (project) =>
          project.id === initialRequest.projectId &&
          project.environmentId === initialRequest.environmentId,
      ) ?? null
    );
  }, [initialRequest.environmentId, initialRequest.projectId, projects]);

  const activeThreadProject = useMemo(() => {
    if (!activeThread) return null;
    return (
      projects.find(
        (project) =>
          project.id === activeThread.projectId &&
          project.environmentId === activeThread.environmentId,
      ) ?? null
    );
  }, [activeThread, projects]);

  const defaultProject = useMemo(
    () =>
      resolveDefaultImportProject({
        preferred: preferredProject,
        activeThreadProject,
        projects,
      }),
    [activeThreadProject, preferredProject, projects],
  );

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedProject = useMemo(() => {
    if (selectedKey !== null) {
      const match = projects.find(
        (project) => `${project.environmentId}:${project.id}` === selectedKey,
      );
      if (match) return match;
    }
    return defaultProject;
  }, [defaultProject, projects, selectedKey]);

  useEffect(() => {
    if (!open) return;
    setSelectedKey(defaultProject ? `${defaultProject.environmentId}:${defaultProject.id}` : null);
    setQuery("");
    setProvider("all");
    setLimit(PAGE_LIMITS[0]);
    setAttachingKey(null);
  }, [defaultProject, open]);

  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [limit, setLimit] = useState<number>(PAGE_LIMITS[0]);
  const [attachingKey, setAttachingKey] = useState<string | null>(null);

  const listAtom = useMemo(() => {
    if (!selectedProject) return null;
    return agentSessionList({
      environmentId: selectedProject.environmentId,
      input: {
        projectId: selectedProject.id,
        expectedWorkspaceRoot: selectedProject.workspaceRoot,
        limit,
      },
    });
  }, [limit, selectedProject]);

  const listQuery = useEnvironmentQuery(listAtom);
  const attachSession = useAtomCommand(agentSessionAttach, { reportFailure: false });

  const filteredEntries = useMemo(
    () => filterImportThreadEntries(listQuery.data?.entries ?? [], { query, provider }),
    [listQuery.data?.entries, provider, query],
  );

  const emptyState = useMemo(
    () =>
      computeImportThreadEmptyState({
        serverEntryCount: listQuery.data?.entries.length ?? 0,
        filteredAlreadyImportedCount: listQuery.data?.filteredAlreadyImportedCount,
        filteredEntries,
        query,
        provider,
      }),
    [
      filteredEntries,
      listQuery.data?.entries.length,
      listQuery.data?.filteredAlreadyImportedCount,
      provider,
      query,
    ],
  );

  const nextLimit = nextPageLimit(limit);
  const canLoadMore =
    nextLimit !== null &&
    (listQuery.data?.truncated === true || (listQuery.data?.entries.length ?? 0) >= limit);

  const providerErrors = listQuery.data?.providerErrors ?? [];
  const showProjectPicker = initialRequest.projectId === undefined || projects.length > 1;

  const handleAttach = useCallback(
    async (entry: AgentSessionEntry) => {
      if (!selectedProject) return;
      const rowKey = `${entry.providerInstanceId}:${entry.providerSessionId}`;
      setAttachingKey(rowKey);
      const result = await attachSession({
        environmentId: selectedProject.environmentId,
        input: {
          projectId: selectedProject.id,
          expectedWorkspaceRoot: selectedProject.workspaceRoot,
          providerInstanceId: entry.providerInstanceId,
          providerSessionId: entry.providerSessionId,
        },
      });
      setAttachingKey(null);
      if (result._tag !== "Success") {
        if (isAtomCommandInterrupted(result)) return;
        const failure = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not import thread",
          description:
            failure instanceof Error && failure.message.trim().length > 0
              ? failure.message
              : "The session could not be attached.",
        });
        return;
      }
      onOpenChange(false);
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(
          scopeThreadRef(selectedProject.environmentId, result.value.threadId),
        ),
      });
      void listQuery.refresh();
    },
    [attachSession, listQuery, onOpenChange, router, selectedProject],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl sm:max-w-xl" showCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <InboxIcon className="size-5 text-muted-foreground" />
            Import thread
          </DialogTitle>
          <DialogDescription>
            Attach a recent Claude, Codex, or Cursor session into this project.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          {showProjectPicker ? (
            <div className="flex flex-col gap-1.5">
              <label
                className="text-xs font-medium text-muted-foreground"
                htmlFor="import-thread-project"
              >
                Project
              </label>
              <Select
                value={
                  selectedProject ? `${selectedProject.environmentId}:${selectedProject.id}` : null
                }
                onValueChange={(value) => {
                  if (typeof value === "string") setSelectedKey(value);
                }}
              >
                <SelectTrigger id="import-thread-project" size="sm" className="w-full">
                  <SelectValue placeholder="Select a project">
                    {selectedProject?.title ?? "Select a project"}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((project) => {
                    const value = `${project.environmentId}:${project.id}`;
                    return (
                      <SelectItem key={value} value={value}>
                        {project.title}
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <SearchIcon className="pointer-events-none absolute start-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search sessions"
                aria-label="Search sessions"
                className="ps-8"
                size="sm"
              />
            </div>
            <ToggleGroup
              aria-label="Provider filter"
              variant="segmented"
              value={[provider]}
              onValueChange={(values) => {
                const next = values[0];
                if (
                  next === "all" ||
                  next === "claudeAgent" ||
                  next === "codex" ||
                  next === "cursor"
                ) {
                  setProvider(next);
                }
              }}
              className="shrink-0"
            >
              <Toggle value="all" aria-label="All providers">
                All
              </Toggle>
              <Toggle value="claudeAgent" aria-label="Claude only">
                Claude
              </Toggle>
              <Toggle value="codex" aria-label="Codex only">
                Codex
              </Toggle>
              <Toggle value="cursor" aria-label="Cursor only">
                Cursor
              </Toggle>
            </ToggleGroup>
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Refresh sessions"
              disabled={!selectedProject || listQuery.isPending}
              onClick={() => listQuery.refresh()}
            >
              <RefreshCwIcon className={cn(listQuery.isPending && "opacity-50")} />
            </Button>
          </div>

          {listQuery.error ? (
            <div className="flex items-start justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive-foreground">
              <span>{listQuery.error}</span>
              <Button type="button" size="xs" variant="outline" onClick={() => listQuery.refresh()}>
                Retry
              </Button>
            </div>
          ) : null}

          {providerErrors.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-sm text-warning-foreground">
              {providerErrors.map((error) => (
                <div key={error.provider} className="flex items-start justify-between gap-2">
                  <span>
                    {providerLabel(error.provider)}: {error.message}
                  </span>
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={() => listQuery.refresh()}
                  >
                    Retry
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          {!selectedProject ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Add a project before importing threads.
            </p>
          ) : listQuery.isPending && listQuery.data === null ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <LoaderCircleIcon className="size-4 animate-spin" />
              Loading sessions…
            </div>
          ) : emptyState !== null ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {importThreadEmptyStateMessage(emptyState)}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5" role="listbox" aria-label="Importable sessions">
              {filteredEntries.map((entry) => {
                const rowKey = `${entry.providerInstanceId}:${entry.providerSessionId}`;
                const driver = getDriverOption(ProviderDriverKind.make(entry.provider));
                const Icon = driver?.icon;
                const busy = attachingKey === rowKey;
                // Recompute relative labels once a minute via nowMinute.
                void nowMinute;
                const relative = formatRelativeTimeLabel(entry.lastActiveAt);
                return (
                  <li key={rowKey}>
                    <button
                      type="button"
                      role="option"
                      disabled={busy || attachingKey !== null}
                      aria-label={`${providerLabel(entry.provider)} ${entry.title}`}
                      className={cn(
                        "flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors",
                        "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
                        "disabled:opacity-64",
                      )}
                      onClick={() => void handleAttach(entry)}
                    >
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        {Icon ? <Icon className="size-4" /> : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="truncate text-sm font-medium text-foreground">
                          {entry.title}
                        </span>
                        <span className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                          {entry.promptPreview}
                        </span>
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground/80">
                          <span>{providerLabel(entry.provider)}</span>
                          {relative ? <span>· {relative}</span> : null}
                        </span>
                      </span>
                      {busy ? (
                        <LoaderCircleIcon className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {canLoadMore && emptyState === null && selectedProject ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full"
              disabled={listQuery.isPending}
              onClick={() => {
                if (nextLimit !== null) setLimit(nextLimit);
              }}
            >
              Load more
            </Button>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
