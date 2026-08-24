import type { ThreadRightPanelState } from "../../rightPanelStore";

import type { FileBreadcrumb } from "./filePath";

export type FileBreadcrumbNavigation = { kind: "noop" } | { kind: "open-files"; focusPath: string };

/** Maps a breadcrumb click to the Files explorer navigation intent. */
export function resolveFileBreadcrumbNavigation(crumb: FileBreadcrumb): FileBreadcrumbNavigation {
  if (crumb.kind === "file") {
    return { kind: "noop" };
  }
  return { kind: "open-files", focusPath: crumb.path };
}

/** Applies breadcrumb navigation to the thread right-panel surface model. */
export function applyFileBreadcrumbNavigation(
  state: ThreadRightPanelState,
  crumb: FileBreadcrumb,
): ThreadRightPanelState {
  const navigation = resolveFileBreadcrumbNavigation(crumb);
  if (navigation.kind === "noop") {
    return state;
  }
  return {
    isOpen: true,
    activeSurfaceId: "files",
    surfaces: [{ id: "files", kind: "files", focusPath: navigation.focusPath }],
  };
}
