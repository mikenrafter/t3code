import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type ThreadRightPanelState,
} from "../../rightPanelStore";
import {
  applyFileBreadcrumbNavigation,
  resolveFileBreadcrumbNavigation,
} from "./fileBreadcrumbNavigation";
import { fileBreadcrumbs } from "./filePath";

const ref = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

const previewingFile = (relativePath: string): ThreadRightPanelState => ({
  isOpen: true,
  activeSurfaceId: `file:${relativePath}`,
  surfaces: [
    {
      id: `file:${relativePath}`,
      kind: "file",
      relativePath,
      revealLine: null,
      revealRequestId: 1,
    },
  ],
});

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("resolveFileBreadcrumbNavigation", () => {
  const crumbs = fileBreadcrumbs("t3code", "apps/web/src/main.tsx");

  it("opens the Files explorer at the project root for a project crumb", () => {
    expect(resolveFileBreadcrumbNavigation(crumbs[0]!)).toEqual({
      kind: "open-files",
      focusPath: "",
    });
  });

  it("opens the Files explorer focused on a directory crumb", () => {
    expect(resolveFileBreadcrumbNavigation(crumbs[2]!)).toEqual({
      kind: "open-files",
      focusPath: "apps/web",
    });
  });

  it("does not navigate for the current file crumb", () => {
    expect(resolveFileBreadcrumbNavigation(crumbs.at(-1)!)).toEqual({ kind: "noop" });
  });
});

describe("applyFileBreadcrumbNavigation", () => {
  const crumbs = fileBreadcrumbs("t3code", "apps/web/src/main.tsx");

  it("replaces the file preview with a focused Files explorer for directory crumbs", () => {
    expect(
      applyFileBreadcrumbNavigation(previewingFile("apps/web/src/main.tsx"), crumbs[2]!),
    ).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files", focusPath: "apps/web" }],
    });
  });

  it("replaces the file preview with the project-root Files explorer for project crumbs", () => {
    expect(
      applyFileBreadcrumbNavigation(previewingFile("apps/web/src/main.tsx"), crumbs[0]!),
    ).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files", focusPath: "" }],
    });
  });

  it("leaves panel state unchanged for the current file crumb", () => {
    const state = previewingFile("apps/web/src/main.tsx");
    expect(applyFileBreadcrumbNavigation(state, crumbs.at(-1)!)).toBe(state);
  });
});

describe("rightPanelStore.navigateFromFileBreadcrumb", () => {
  it("activates the Files explorer focused on the clicked directory", () => {
    const crumbs = fileBreadcrumbs("t3code", "apps/web/src/main.tsx");
    useRightPanelStore.getState().openFile(ref, "apps/web/src/main.tsx");

    useRightPanelStore.getState().navigateFromFileBreadcrumb(ref, crumbs[2]!);

    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref)).toEqual({
      isOpen: true,
      activeSurfaceId: "files",
      surfaces: [{ id: "files", kind: "files", focusPath: "apps/web" }],
    });
  });
});
