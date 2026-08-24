{
  description = "t3code dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
      in
      {
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
