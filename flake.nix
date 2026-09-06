{
  description = "t3code dev environment and Nix package";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";

    # Upstream Nix packaging for t3code. This flake reuses it wholesale and
    # only swaps in this branch's source plus the pnpm store that matches this
    # branch's lockfile.
    #
    # Deliberately does not follow nixpkgs: llm-agents.nix publishes a binary
    # cache keyed to its own nixpkgs pin, and re-pointing it here would force
    # every dependency to rebuild from source.
    llm-agents.url = "github:numtide/llm-agents.nix";
  };

  outputs = { self, nixpkgs, flake-utils, llm-agents }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = nixpkgs.lib;
        agents = llm-agents.packages.${system};

        # llm-agents pins the upstream v0.0.33 tarball together with the pnpm
        # store hash that goes with it. This branch has been synced with t3code
        # main since that tag, so pnpm-lock.yaml gained dependencies the pinned
        # store does not contain (@clerk/electron among them) and the build dies
        # with ERR_PNPM_NO_OFFLINE_TARBALL. Refetch the store from this branch
        # and keep its hash here, in the same repo as the lockfile that
        # determines it — a later sync with main updates both in one commit.
        #
        # native/ is unchanged from v0.0.33, so the Rust resource-monitor and
        # its cargoHash are left on the upstream source.
        t3code = agents.t3code.override {
          t3code-unwrapped = agents.t3code.unwrapped.overrideAttrs (old: {
            src = self;
            pnpmDeps = old.pnpmDeps.override {
              src = self;
              hash = "sha256-t/hmpXdYPnBFx18A6NrSL4zSvVnUDIjIPtLjGOzoaDk=";
            };
          });
        };
      in
      {
        # t3code is not packaged for every system flake-utils enumerates
        # (x86_64-darwin in particular), so only expose it where it exists.
        packages = lib.optionalAttrs (agents ? t3code) {
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
