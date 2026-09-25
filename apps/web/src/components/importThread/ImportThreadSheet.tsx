import { useAtomValue } from "@effect/atom-react";
import {
  ProviderDriverKind,
  resolveEnvironmentMachineKind,
  type AgentSessionEntry,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  scopeProjectRef,
  scopedProjectKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { Atom } from "effect/unstable/reactivity";
import {
  ChevronDownIcon,
  FolderPlusIcon,
  InboxIcon,
  LayersIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SearchIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";

import { openCommandPalette } from "../../commandPaletteBus";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useClientSettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import { selectProjectGroupingSettings } from "../../logicalProject";
import {
  buildSidebarProjectPickerEntries,
  buildSidebarProjectSnapshots,
  projectGroupsSpanEnvironments,
} from "../../sidebarProjectGrouping";
import { cn } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { agentSessionAttach, agentSessionList } from "../../state/agentSessions";
import { useProjects, useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { getDriverOption } from "../settings/providerDriverMeta";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { sortLogicalProjectsForSidebar } from "../Sidebar.logic";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
  showAnchoredCopySuccessToast,
} from "../ui/anchoredCopyToast";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  DEFAULT_IMPORT_HISTORY_MODE,
  IMPORT_THREAD_PROJECT_AUTOMATIC,
  PAGE_LIMITS,
  computeImportThreadEmptyState,
  filterImportThreadEntries,
  formatImportThreadContextParts,
  formatImportThreadTimeParts,
  importThreadEmptyStateMessage,
  importThreadRowBlockedReason,
  isAutomaticImportProjectSelection,
  isImportThreadRowDisabled,
  nextPageLimit,
  providerLabel,
  resolveImportAttachProject,
  resolveImportListEnvironmentId,
  type ImportThreadProjectSelection,
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

/** Copies the provider's session id (not a T3 thread id) for debugging / lookup. */
function ImportThreadCopySessionIdButton({ providerSessionId }: { providerSessionId: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    target: "provider session id",
    onCopy: () => showAnchoredCopySuccessToast(ref),
    onError: (error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
  });

  return (
    <Button
      ref={ref}
      type="button"
      size="xs"
      variant="ghost"
      className="mt-1 shrink-0 text-muted-foreground"
      aria-label="Copy provider session ID"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        copyToClipboard(providerSessionId, undefined);
      }}
    >
      {isCopied ? "Copied" : "Copy ID"}
    </Button>
  );
}

function ImportThreadSheet({
  open,
  initialRequest: _initialRequest,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly initialRequest: ImportThreadSheetRequest;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const projects = useProjects();
  const threads = useThreadShells();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const projectSortOrder = useClientSettings((settings) => settings.sidebarProjectSortOrder);
  const router = useRouter();
  const nowMinute = useNowMinute();
  const openAddProject = useCallback(() => openCommandPalette({ open: "add-project" }), []);

  const [selectedKey, setSelectedKey] = useState<ImportThreadProjectSelection>(
    IMPORT_THREAD_PROJECT_AUTOMATIC,
  );
  const [useCompaction, setUseCompaction] = useState(DEFAULT_IMPORT_HISTORY_MODE === "compaction");
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<ProviderFilter>("all");
  const [limit, setLimit] = useState<number>(PAGE_LIMITS[0]);
  const [attachingKey, setAttachingKey] = useState<string | null>(null);

  const automatic = isAutomaticImportProjectSelection(selectedKey);

  const selectedProject = useMemo(() => {
    if (automatic) return null;
    return (
      projects.find((project) => `${project.environmentId}:${project.id}` === selectedKey) ?? null
    );
  }, [automatic, projects, selectedKey]);

  useEffect(() => {
    if (!open) return;
    setSelectedKey(IMPORT_THREAD_PROJECT_AUTOMATIC);
    setUseCompaction(DEFAULT_IMPORT_HISTORY_MODE === "compaction");
    setQuery("");
    setProvider("all");
    setLimit(PAGE_LIMITS[0]);
    setAttachingKey(null);
  }, [open]);

  const listEnvironmentId = useMemo(() => {
    if (selectedProject) return selectedProject.environmentId;
    return resolveImportListEnvironmentId({ primaryEnvironmentId, projects });
  }, [primaryEnvironmentId, projects, selectedProject]);

  const environmentLabelById = useMemo(
    () =>
      new Map(
        environments.map((environment) => [environment.environmentId, environment.label] as const),
      ),
    [environments],
  );
  const projectGroups = useMemo(
    () =>
      sortLogicalProjectsForSidebar(
        buildSidebarProjectSnapshots({
          projects,
          settings: projectGroupingSettings,
          primaryEnvironmentId,
          resolveEnvironmentLabel: (environmentId) =>
            environmentLabelById.get(environmentId) ?? null,
        }),
        threads,
        projectSortOrder,
      ),
    [
      environmentLabelById,
      primaryEnvironmentId,
      projectGroupingSettings,
      projectSortOrder,
      projects,
      threads,
    ],
  );
  const showProjectEnvironments = useMemo(
    () => projectGroupsSpanEnvironments(projectGroups),
    [projectGroups],
  );
  const environmentMachineById = useMemo(
    () =>
      new Map(
        environments.map(
          (environment) =>
            [
              environment.environmentId,
              resolveEnvironmentMachineKind(environment.serverConfig),
            ] as const,
        ),
      ),
    [environments],
  );
  const selectedProjectRef = useMemo(
    () =>
      selectedProject ? scopeProjectRef(selectedProject.environmentId, selectedProject.id) : null,
    [selectedProject],
  );
  const projectPickerEntries = useMemo(
    () =>
      buildSidebarProjectPickerEntries({
        groups: projectGroups,
        preferredProjectRef: selectedProjectRef,
      }),
    [projectGroups, selectedProjectRef],
  );
  const projectEntryByKey = useMemo(
    () => new Map(projectPickerEntries.map((entry) => [entry.group.projectKey, entry] as const)),
    [projectPickerEntries],
  );
  const selectedProjectGroup =
    selectedProjectRef === null
      ? null
      : (projectGroups.find((group) =>
          group.memberProjectRefs.some(
            (projectRef) => scopedProjectKey(projectRef) === scopedProjectKey(selectedProjectRef),
          ),
        ) ?? null);
  const selectedProjectKey = automatic
    ? IMPORT_THREAD_PROJECT_AUTOMATIC
    : (selectedProjectGroup?.projectKey ?? "");
  const selectedProjectDisplayName = automatic
    ? "Automatic"
    : (selectedProjectGroup?.displayName ?? selectedProject?.title ?? null);

  const projectById = useMemo(
    () => new Map(projects.map((project) => [project.id, project] as const)),
    [projects],
  );

  const listAtom = useMemo(() => {
    if (!listEnvironmentId) return null;
    if (automatic) {
      return agentSessionList({
        environmentId: listEnvironmentId,
        input: { limit },
      });
    }
    if (!selectedProject) return null;
    return agentSessionList({
      environmentId: selectedProject.environmentId,
      input: {
        projectId: selectedProject.id,
        expectedWorkspaceRoot: selectedProject.workspaceRoot,
        limit,
      },
    });
  }, [automatic, limit, listEnvironmentId, selectedProject]);

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
        ...(listQuery.data?.filteredAlreadyImportedCount !== undefined
          ? { filteredAlreadyImportedCount: listQuery.data.filteredAlreadyImportedCount }
          : {}),
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
  const canList =
    listEnvironmentId !== null && (automatic ? projects.length > 0 : selectedProject !== null);

  const handleAttach = useCallback(
    async (entry: AgentSessionEntry) => {
      const destination = resolveImportAttachProject({
        automatic,
        entryProjectId: entry.projectId,
        projects,
        selectedProject,
      });
      if (!destination) return;
      if (isImportThreadRowDisabled(entry)) return;
      const rowKey = `${entry.providerInstanceId}:${entry.providerSessionId}`;
      setAttachingKey(rowKey);
      const result = await attachSession({
        environmentId: destination.environmentId,
        input: {
          projectId: destination.id,
          expectedWorkspaceRoot: destination.workspaceRoot,
          providerInstanceId: entry.providerInstanceId,
          providerSessionId: entry.providerSessionId,
          historyMode: useCompaction ? "compaction" : "full",
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
          scopeThreadRef(destination.environmentId, result.value.threadId),
        ),
      });
      void listQuery.refresh();
    },
    [
      attachSession,
      automatic,
      listQuery,
      onOpenChange,
      projects,
      router,
      selectedProject,
      useCompaction,
    ],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-xl overflow-x-hidden sm:max-w-xl" showCloseButton>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <InboxIcon className="size-5 text-muted-foreground" />
            Import thread
          </DialogTitle>
        </DialogHeader>
        <DialogPanel className="flex min-w-0 flex-col gap-3 overflow-x-hidden">
          <div className="flex flex-col gap-1.5">
            <label
              className="text-xs font-medium text-muted-foreground"
              htmlFor="import-thread-project"
            >
              Attach a recent Claude, Codex, or Cursor session into this project.
            </label>
            <div className="flex flex-wrap items-center gap-3">
              <Menu>
                <MenuTrigger
                  id="import-thread-project"
                  disabled={projectPickerEntries.length === 0}
                  className={cn(
                    "relative inline-flex w-auto shrink cursor-pointer select-none items-center justify-between gap-1.5 rounded-lg border border-input bg-background text-left text-base text-foreground shadow-xs/5 outline-none transition-[color,box-shadow,background-color]",
                    "min-h-8 px-[calc(--spacing(2.5)-1px)] sm:min-h-7 sm:text-sm",
                    "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24",
                    "disabled:pointer-events-none disabled:opacity-64",
                    "dark:bg-input/32",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    {automatic ? (
                      <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
                    ) : selectedProjectGroup ? (
                      <ProjectFavicon project={selectedProjectGroup} className="size-4 shrink-0" />
                    ) : null}
                    <span className="truncate">
                      {selectedProjectDisplayName ?? "Select a project"}
                    </span>
                  </span>
                  <ChevronDownIcon className="-me-1 size-3 shrink-0 opacity-50" />
                </MenuTrigger>
                <MenuPopup align="start" className="max-h-80 w-max min-w-40 overflow-y-auto">
                  <MenuRadioGroup
                    value={selectedProjectKey}
                    onValueChange={(value) => {
                      if (value === IMPORT_THREAD_PROJECT_AUTOMATIC) {
                        setSelectedKey(IMPORT_THREAD_PROJECT_AUTOMATIC);
                        return;
                      }
                      const entry = projectEntryByKey.get(value as string);
                      if (!entry || value === selectedProjectKey) return;
                      const project = entry.targetProject;
                      setSelectedKey(`${project.environmentId}:${project.id}`);
                    }}
                  >
                    <MenuRadioItem
                      value={IMPORT_THREAD_PROJECT_AUTOMATIC}
                      closeOnClick
                      className="[&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                    >
                      <LayersIcon className="size-4 shrink-0 text-muted-foreground" />
                      <span className="truncate">Automatic</span>
                    </MenuRadioItem>
                    <MenuSeparator />
                    {projectPickerEntries.map(({ group }) => (
                      <MenuRadioItem
                        key={group.projectKey}
                        value={group.projectKey}
                        closeOnClick
                        className="[&>span:last-child]:flex [&>span:last-child]:min-w-0 [&>span:last-child]:items-center [&>span:last-child]:gap-2"
                      >
                        <ProjectFavicon project={group} className="size-4 shrink-0" />
                        <Tooltip>
                          <TooltipTrigger render={<span className="block min-w-0 truncate" />}>
                            {group.displayName}
                          </TooltipTrigger>
                          <TooltipPopup side="top" className="max-w-80">
                            {group.displayName}
                          </TooltipPopup>
                        </Tooltip>
                        {showProjectEnvironments ? (
                          <ProjectEnvironmentBadge
                            group={group}
                            primaryEnvironmentId={primaryEnvironmentId}
                            machineByEnvironmentId={environmentMachineById}
                          />
                        ) : null}
                      </MenuRadioItem>
                    ))}
                  </MenuRadioGroup>
                  <MenuSeparator />
                  <MenuItem onClick={openAddProject}>
                    <FolderPlusIcon />
                    New project
                  </MenuItem>
                </MenuPopup>
              </Menu>
              <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
                <Checkbox
                  checked={useCompaction}
                  onCheckedChange={(checked) => setUseCompaction(checked === true)}
                />
                Use compacted chats
              </label>
            </div>
          </div>

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
              disabled={!canList || listQuery.isPending}
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

          {!canList ? (
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
            <ul
              className="flex min-w-0 flex-col gap-0.5"
              role="listbox"
              aria-label="Importable sessions"
            >
              {filteredEntries.map((entry) => {
                const rowKey = `${entry.providerInstanceId}:${entry.providerSessionId}`;
                const driver = getDriverOption(ProviderDriverKind.make(entry.provider));
                const Icon = driver?.icon;
                const busy = attachingKey === rowKey;
                const blockedReason = importThreadRowBlockedReason(entry);
                const rowDisabled =
                  isImportThreadRowDisabled(entry) || busy || attachingKey !== null;
                // Recompute relative labels once a minute via nowMinute.
                void nowMinute;
                const timeParts = formatImportThreadTimeParts(entry);
                const contextParts = formatImportThreadContextParts(
                  entry,
                  useCompaction ? "compaction" : "full",
                );
                const entryProject = projectById.get(entry.projectId);
                const mutedMetaClass = "text-muted-foreground/55";
                const activeMetaClass = "text-muted-foreground/80";
                return (
                  <li
                    key={rowKey}
                    className={cn(
                      "flex min-w-0 items-start gap-1 overflow-hidden rounded-lg px-1 py-1 transition-colors",
                      "hover:bg-accent has-[:focus-visible]:bg-accent",
                      rowDisabled && "opacity-64",
                    )}
                  >
                    <button
                      type="button"
                      role="option"
                      disabled={rowDisabled}
                      aria-label={`${providerLabel(entry.provider)} ${entry.title}`}
                      className={cn(
                        "flex min-w-0 flex-1 items-start gap-3 overflow-hidden rounded-md px-1 py-1 text-left",
                        "focus-visible:outline-none",
                      )}
                      onClick={() => void handleAttach(entry)}
                    >
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        {entryProject ? (
                          <ProjectFavicon project={entryProject} className="size-4 shrink-0" />
                        ) : (
                          <span className="size-4 rounded-sm bg-muted-foreground/20" />
                        )}
                      </span>
                      <span className="min-w-0 flex-1 overflow-hidden">
                        <span className="block truncate text-sm font-medium text-foreground">
                          {entry.title}
                        </span>
                        <span className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
                          {entry.promptPreview}
                        </span>
                        {blockedReason ? (
                          <span className="mt-0.5 text-xs text-muted-foreground">
                            {blockedReason}
                          </span>
                        ) : null}
                        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]">
                          {Icon ? <Icon className={cn("size-3 shrink-0", mutedMetaClass)} /> : null}
                          <span className={cn("truncate", mutedMetaClass)}>
                            {entry.projectTitle}
                          </span>
                          <span className={mutedMetaClass}>·</span>
                          <span className={mutedMetaClass}>{providerLabel(entry.provider)}</span>
                          {timeParts.createdLabel ? (
                            <>
                              <span className={mutedMetaClass}>·</span>
                              <span className={mutedMetaClass}>{timeParts.createdLabel}</span>
                            </>
                          ) : null}
                          {timeParts.lastMessageLabel ? (
                            <>
                              <span className={mutedMetaClass}>·</span>
                              <span className={activeMetaClass}>{timeParts.lastMessageLabel}</span>
                            </>
                          ) : null}
                          {contextParts.maxLabel ? (
                            <>
                              <span className={mutedMetaClass}>·</span>
                              <span className={mutedMetaClass}>{contextParts.maxLabel}</span>
                            </>
                          ) : null}
                          {contextParts.usedLabel ? (
                            <>
                              <span className={mutedMetaClass}>·</span>
                              <span className={activeMetaClass}>{contextParts.usedLabel}</span>
                            </>
                          ) : null}
                          {contextParts.percentLabel ? (
                            <>
                              <span className={mutedMetaClass}>·</span>
                              <span className={activeMetaClass}>{contextParts.percentLabel}</span>
                            </>
                          ) : null}
                        </span>
                      </span>
                      {busy ? (
                        <LoaderCircleIcon className="mt-1 size-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : null}
                    </button>
                    <ImportThreadCopySessionIdButton providerSessionId={entry.providerSessionId} />
                  </li>
                );
              })}
            </ul>
          )}

          {canLoadMore && emptyState === null && canList ? (
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
