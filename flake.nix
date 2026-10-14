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

        # llm-agents.nix's own `packages.${system}` output runs every package
        # it ships (~200+) through a per-system availability filter, which
        # forces each one to construct just to check its meta — so merely
        # touching one attribute of `packages.${system}` can abort on an
        # unrelated, broken package elsewhere in their tree. `overlays.
        # shared-nixpkgs` exposes the same packages unfiltered as plain lazy
        # attrset keys, so only `t3code` itself gets forced below.
        agents = (pkgs.extend llm-agents.overlays.shared-nixpkgs).llm-agents;

        # Electron is unfree; llm-agents' packaging (post 3e108f2a) takes
        # `electron_43` from its own nixpkgs pin. Import that pin with
        # allowUnfree and pass it through so eval does not hit the free-only
        # consumer nixpkgs.
        agentsPkgs = import llm-agents.inputs.nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

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
          t3code-unwrapped =
            (agents.t3code.unwrapped.override {
              electron_43 = agentsPkgs.electron_43;
            }).overrideAttrs
              (old: {
                src = self;
                pnpmDeps = old.pnpmDeps.override {
                  src = self;
                  hash = "sha256-VS3JQu+wbWuVeQaH3+DqtrFU5MY6EUZS+Gv+awcFGAA=";
                };
              });
        };
      in
      {
        # t3code is not packaged for every system flake-utils enumerates
        # (x86_64-darwin in particular), so only expose it where it exists.
        # `agents ? t3code` is now a cheap key check (see `agents` above);
        # the actual per-system availability check mirrors llm-agents.nix's
        # own `available` predicate, but against the *overridden* `t3code`
        # above rather than `agents.t3code` directly — the latter's default
        # `t3code-unwrapped` can fail to construct on its own (e.g. an
        # electron_NN version mismatch against llm-agents' own nixpkgs pin)
        # even when our override builds fine, since it never evaluates
        # that default.
        packages = lib.optionalAttrs (
          agents ? t3code
          && lib.meta.availableOn pkgs.stdenv.hostPlatform t3code
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
