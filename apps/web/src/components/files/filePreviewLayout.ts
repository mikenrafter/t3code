export type FilePreviewLayout = "mobile" | "desktop";

/** Explorer shares the preview column only on desktop when the user left it open. */
export function shouldShowFileExplorerBesidePreview(options: {
  explorerOpen: boolean;
  hasOpenFile: boolean;
  layout: FilePreviewLayout;
}): boolean {
  if (!options.hasOpenFile) return true;
  if (options.layout === "mobile") return false;
  return options.explorerOpen;
}

/** Mobile file view uses breadcrumbs to leave; the explorer toggle would re-split the pane. */
export function shouldShowFileExplorerToggle(options: {
  hasOpenFile: boolean;
  layout: FilePreviewLayout;
}): boolean {
  return options.hasOpenFile && options.layout === "desktop";
}
