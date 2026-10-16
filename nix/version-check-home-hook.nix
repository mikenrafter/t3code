{
  lib,
  makeSetupHook,
}:

# Vendored the same way as nix/formatelf.nix: llm-agents.nix's own packaging
# of a small, independent setup hook (not an llm-agents.nix dependency as
# such — just copied here so this flake needs none of it).
makeSetupHook {
  name = "version-check-home-hook";
  passthru.hideFromDocs = true;
  meta = {
    description = "Setup hook that provides a writable HOME for versionCheckHook";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
} ./version-check-home.sh
