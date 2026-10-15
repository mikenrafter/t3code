{
  description = "t3code dev environment and Nix package";

  inputs = {
    # Pinned to a specific nixpkgs-unstable commit, not the nixos-26.05
    # branch: electron_44 (needed below) isn't backported to the stable
    # branch yet, only unstable has it. Pin by commit rather than branch
    # name so this doesn't silently re-resolve to a newer/older electron_NN
    # later — bump deliberately when it needs to move.
    nixpkgs.url = "github:NixOS/nixpkgs/8edc0c72e3a38faf5434e40d1f19431125fe4b30";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        # Electron is unfree, and `nix/unwrapped.nix` takes it (and
        # everything else) straight from here — no llm-agents.nix
        # dependency. ai-cli (a separate scout module) pulls llm-agents.nix
        # for the claude-code/codex binaries; t3code doesn't need to.
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };
        lib = nixpkgs.lib;

        t3code = pkgs.callPackage ./nix/package.nix {
          t3code-unwrapped = pkgs.callPackage ./nix/unwrapped.nix {
            inherit self;
            formatelf = pkgs.callPackage ./nix/formatelf.nix { };
            versionCheckHomeHook = pkgs.callPackage ./nix/version-check-home-hook.nix { };
          };
        };
      in
      {
        # t3code is not packaged for every system flake-utils enumerates
        # (x86_64-darwin in particular), so only expose it where it exists.
        packages = lib.optionalAttrs (
          lib.meta.availableOn pkgs.stdenv.hostPlatform t3code
          && !(t3code.meta.broken or false)
        ) {
          inherit t3code;
          default = t3code;
        };

        devShells.default = pkgs.mkShell {
          packages = [
            # engines.node in package.json requires "^24.13.1"; nodejs_24
            # bundles a matching corepack binary (Node's built-in pnpm
            # activator) so no separate pnpm package is needed.
            pkgs.nodejs_24

            # native/resource-monitor/Cargo.toml uses edition = "2024",
            # which needs rustc/cargo >= 1.85. No rust-toolchain.toml pins
            # a specific version in this repo, so use nixpkgs' stable
            # rustc/cargo.
            pkgs.rustc
            pkgs.cargo
          ];

          shellHook = ''
            export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
          '';
        };
      });
}
