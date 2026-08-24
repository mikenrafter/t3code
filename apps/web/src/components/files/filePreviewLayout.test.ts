import { describe, expect, it } from "vite-plus/test";

import {
  shouldShowFileExplorerBesidePreview,
  shouldShowFileExplorerToggle,
} from "./filePreviewLayout";

describe("shouldShowFileExplorerBesidePreview", () => {
  it("gives an open file the full pane on mobile even when the explorer preference is on", () => {
    expect(
      shouldShowFileExplorerBesidePreview({
        explorerOpen: true,
        hasOpenFile: true,
        layout: "mobile",
      }),
    ).toBe(false);
  });

  it("still shows the explorer as the whole pane when no file is open", () => {
    expect(
      shouldShowFileExplorerBesidePreview({
        explorerOpen: false,
        hasOpenFile: false,
        layout: "mobile",
      }),
    ).toBe(true);
  });

  it("keeps the desktop split when the explorer is open beside a file", () => {
    expect(
      shouldShowFileExplorerBesidePreview({
        explorerOpen: true,
        hasOpenFile: true,
        layout: "desktop",
      }),
    ).toBe(true);
  });
});

describe("shouldShowFileExplorerToggle", () => {
  it("hides the explorer toggle on mobile file previews", () => {
    expect(shouldShowFileExplorerToggle({ hasOpenFile: true, layout: "mobile" })).toBe(false);
  });

  it("keeps the explorer toggle on desktop file previews", () => {
    expect(shouldShowFileExplorerToggle({ hasOpenFile: true, layout: "desktop" })).toBe(true);
  });
});
