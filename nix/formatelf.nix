{
  lib,
  stdenv,
  rustPlatform,
  fetchFromGitHub,
  makeSetupHook,
}:

# Vendored the same way llm-agents.nix does: Mic92/formatelf has no nixpkgs
# packaging of its own yet. Not an llm-agents.nix dependency — this is their
# packaging of someone else's independent tool, copied here so t3code's own
# Nix packaging doesn't need llm-agents.nix at all.
let
  version = "0-unstable-2026-08-11";

  src = fetchFromGitHub {
    owner = "Mic92";
    repo = "formatelf";
    rev = "2b36d819b48c0bfd4a084e6f0ce430633d8ee5f4";
    hash = "sha256-wWCpCxVogWKo/ivGfmAmD8YE8H4CQfs52lMdKsELK/w=";
  };

  formatelf = rustPlatform.buildRustPackage {
    pname = "formatelf";
    inherit version src;

    cargoHash = "sha256-+chzNYelw+fcWhIMSbJgVyOD48vV/Z6Cg5nhbfs16Xs=";

    # The test suite needs zig-built fixtures and a reference patchelf, neither
    # of which exists in the build sandbox.
    doCheck = false;

    # auto-formatelf is the multi-call personality selected by argv[0].
    postInstall = ''
      ln -s formatelf $out/bin/auto-formatelf
    '';

    meta = {
      description = "Modify the dynamic linker and RPATH of ELF executables";
      homepage = "https://github.com/Mic92/formatelf";
      license = lib.licenses.mit;
      mainProgram = "formatelf";
      platforms = lib.platforms.linux;
    };
  };

  # Drop-in equivalent of nixpkgs' autoPatchelfHook, backed by auto-formatelf.
  # The bintools dependency supplies $NIX_BINTOOLS, from which auto-formatelf
  # reads the dynamic linker and libc.
  hook = makeSetupHook {
    name = "auto-formatelf-hook";
    propagatedBuildInputs = [
      formatelf
      stdenv.cc.bintools
    ];
    passthru.hideFromDocs = true;
    # Standalone binary for patching ELFs outside a build (e.g. at runtime).
    passthru.bin = formatelf;
    meta = {
      description = "Setup hook that patches ELF binaries via formatelf";
      license = lib.licenses.mit;
      platforms = lib.platforms.linux;
    };
  } "${src}/auto-formatelf-hook.sh";
in
hook
