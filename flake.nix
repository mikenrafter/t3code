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

    node-dyndrv.url = "github:mikenrafter/node-dyndrv";
  };

  outputs = { self, nixpkgs, flake-utils, llm-agents, node-dyndrv }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = nixpkgs.lib;
        agents = llm-agents.packages.${system};

        # Electron is unfree; llm-agents' packaging (post 7890992b) takes
        # `electron_44` from its own nixpkgs pin. Import that pin with
        # allowUnfree and pass it through so eval does not hit the free-only
        # consumer nixpkgs.
        agentsPkgs = import llm-agents.inputs.nixpkgs {
          inherit system;
          config.allowUnfree = true;
        };

        # apps/web's production build (scripts/lib/third-party-licenses.ts,
        # wired in via apps/web/vite.config.ts) fetches each dependency's SPDX
        # license text from raw.githubusercontent.com on a cache miss, and
        # only ever writes that cache to the gitignored `.generated/` — so it
        # is never part of `src`. Nix's build sandbox has no network, so the
        # build fails outright unless every license this branch's
        # dependencies need is pre-seeded from a fixed-output fetch instead.
        # Re-derive the needed set with:
        #   pnpm --filter @t3tools/web run build
        #   find .generated/third-party-licenses/spdx -type f
        spdxLicenseListRevision = "c4a7237ec8f4654e867546f9f409749300f1bf4c";
        spdxLicenseListVersion = "v3.28.0";
        spdxLicenseHashes = {
          "Apache-2.0" = "sha256-iyt7wmfXAL6UCFzSyDA+Atj4ODKLKnMQ3DqIQNPKErs=";
          "BSD-2-Clause" = "sha256-h2hDpwacR4mNECQyo1vjMqRXz3r/gJTMsYqj315jQJI=";
          "BSD-3-Clause" = "sha256-RXYFS3RBfUAh/9ovY7h/3lJ5Hj7ZTu7yznkwJRtDcwE=";
          "CC0-1.0" = "sha256-gdRg6RFSHhS1Ky/Y4Gl5Wscx6JhspYpdKUFdzAHqoSU=";
          "ISC" = "sha256-VJTDV7IdtsBt1r1r1J1ldZINPVNDQE5vVFkWPmjn5Yo=";
          "MIT" = "sha256-fuCJ3MxiW/GLCrHoDgxLysVYeIT1viXZATuK1sYd1Dk=";
          "Unlicense" = "sha256-itR5uQEH/xGJKbe09Fvk/axB/Aq0J6LEIbwwY52X4fs=";
        };
        spdxLicenseCache = pkgs.linkFarm "t3code-spdx-license-cache" (
          lib.mapAttrsToList (id: hash: {
            name = "${id}.json";
            path = pkgs.fetchurl {
              url = "https://raw.githubusercontent.com/spdx/license-list-data/${spdxLicenseListRevision}/json/details/${id}.json";
              inherit hash;
            };
          }) spdxLicenseHashes
        );
        seedSpdxLicenseCache = ''
          mkdir -p .generated/third-party-licenses/spdx/${spdxLicenseListVersion}
          chmod -R u+w .generated
          cp -f ${spdxLicenseCache}/*.json .generated/third-party-licenses/spdx/${spdxLicenseListVersion}/
        '';

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
              electron_44 = agentsPkgs.electron_44;
            }).overrideAttrs
              (old: {
                src = self;
                pnpmDeps = old.pnpmDeps.override {
                  src = self;
                  hash = "sha256-0YplEpvx75y6NsjS+Re1EWkbbC5x083ZTY6q4F7Tggo=";
                };
              });
        };

        # Incremental build of the web app alone, via node-dyndrv, sharing
        # the same pnpmDeps store as the full t3code package above. Useful
        # for iterating on apps/web without paying for the whole desktop
        # build (native resource-monitor, electron packaging, etc.) on every
        # change.
        t3code-web = (node-dyndrv.lib.${system}.buildNodeWorkspace {
          pname = "t3code-web";
          version = t3code.version;
          src = self;
          pnpmDeps = t3code.passthru.pnpmDeps;
          pnpm = agentsPkgs.pnpm_11;
          workspace = "@t3tools/web";
          buildScript = "build";
        }).overrideAttrs (old: {
          buildPhase = seedSpdxLicenseCache + old.buildPhase;
        });
      in
      {
        # t3code is not packaged for every system flake-utils enumerates
        # (x86_64-darwin in particular), so only expose it where it exists.
        packages = lib.optionalAttrs (agents ? t3code) {
          inherit t3code t3code-web;
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
