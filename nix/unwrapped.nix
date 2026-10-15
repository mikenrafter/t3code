{
  lib,
  self,
  stdenv,
  fetchFromGitHub,
  fetchPnpmDeps,
  pnpm_11,
  pnpmConfigHook,
  nodejs_24,
  node-gyp,
  pkg-config,
  formatelf,
  python3,
  cacert,
  makeBinaryWrapper,
  installShellFiles,
  rustPlatform,
  versionCheckHook,
  versionCheckHomeHook,
}:

let
  pname = "t3code";
  version = (lib.importJSON (self + "/apps/desktop/package.json")).version;
  pnpm = pnpm_11;

  src = self;

  # The web build's third-party-licenses vite plugin downloads SPDX license
  # texts unless they are already cached under .generated/. Keep rev in sync
  # with SPDX_LICENSE_LIST_REVISION in scripts/lib/third-party-licenses.ts.
  # (Neither apps/desktop's build nor the server-only build below imports
  # this plugin at all — only apps/web's vite config does — but keeping the
  # check means a future resync with upstream can't silently drift it out
  # from under us.)
  spdxLicenses = fetchFromGitHub {
    owner = "spdx";
    repo = "license-list-data";
    rev = "c4a7237ec8f4654e867546f9f409749300f1bf4c";
    sparseCheckout = [ "json/details" ];
    hash = "sha256-DnrdJ13M8Vf8Dq8qKlO7Ad5jXa8L9YU9PBlpp7B9BoI=";
  };

  resourceMonitor = rustPlatform.buildRustPackage {
    pname = "t3code-resource-monitor";
    inherit version src;

    # `src = self` unpacks to a plain "source" directory (confirmed by the
    # actual build log), not "${src.name}" — that only applies to fetched
    # tarballs, which this isn't anymore.
    sourceRoot = "source/native/resource-monitor";
    # inspects the test process's own RSS via procfs, 0 on some builders
    checkFlags = [ "--skip=tests::loads_details_when_an_existing_process_becomes_selected" ];
    cargoHash = "sha256-5cmG2daM1bVOA23gjjoalbx0fEL1hmqV6WZov0sUZp8=";
  };

  platformKey =
    {
      x86_64-linux = "linux-x64";
      aarch64-linux = "linux-arm64";
      aarch64-darwin = "darwin-arm64";
    }
    .${stdenv.hostPlatform.system};

  # Keep the same filter set as upstream's build:desktop here: this list
  # drives fetchPnpmDeps and the initial `pnpm install` (the whole
  # lockfile-consistent dependency graph, including hoisting and optional
  # native-binding packages like vite-plus's), not what actually gets
  # built. Narrowing *that* happens downstream (buildPhase/installPhase's
  # --filter t3) — dropping @t3tools/desktop... here instead changed
  # pnpm's install-time resolution and broke vite-plus's native binding
  # placement (unrelated to Electron at all).
  pnpmWorkspaces = [
    "@t3tools/monorepo"
    "t3..."
    "@t3tools/desktop..."
    "@t3tools/scripts..."
  ];
in
stdenv.mkDerivation {
  inherit
    pname
    version
    src
    pnpmWorkspaces
    ;

  strictDeps = true;
  __structuredAttrs = true;

  # Public production identifiers, also embedded in upstream release builds.
  # loadRepoEnv supplies the corresponding VITE_* values for the web frontend.
  env = {
    T3CODE_RELAY_URL = "https://relay.t3.codes";
    T3CODE_CLERK_PUBLISHABLE_KEY = "pk_live_Y2xlcmsudDMuY29kZXMk";
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID = "hzxSgY2cH10sDU2r";
  };

  pnpmDeps = fetchPnpmDeps {
    inherit
      pnpm
      pname
      version
      src
      pnpmWorkspaces
      ;
    fetcherVersion = 4;
    hash = "sha256-VS3JQu+wbWuVeQaH3+DqtrFU5MY6EUZS+Gv+awcFGAA=";
  };

  nativeBuildInputs = [
    cacert
    installShellFiles
    makeBinaryWrapper
    node-gyp
    nodejs_24
    pnpm
    pnpmConfigHook
    python3
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [
    formatelf
    pkg-config
  ];

  # Server-only native deps (node-pty's prebuilt binaries need libstdc++ at
  # runtime, see postFixup below). No libsecret: that's only pulled in by
  # native/browser-secret, which is desktop/Electron-only and not built here.
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
  ];

  postPatch = ''
    spdxRev=$(sed -n 's/^const SPDX_LICENSE_LIST_REVISION = "\(.*\)";/\1/p' scripts/lib/third-party-licenses.ts)
    if [[ "$spdxRev" != "${spdxLicenses.rev}" ]]; then
      echo "error: upstream pins SPDX license-list-data $spdxRev, update spdxLicenses" >&2
      exit 1
    fi
    spdxVer=$(sed -n 's/^const SPDX_LICENSE_LIST_VERSION = "\(.*\)";/\1/p' scripts/lib/third-party-licenses.ts)
    mkdir -p .generated/third-party-licenses/spdx
    ln -s ${spdxLicenses}/json/details ".generated/third-party-licenses/spdx/$spdxVer"
  '';

  preBuild = ''
    export pnpm_config_verify_deps_before_run=false

    node scripts/update-release-package-versions.ts ${version}

    export npm_config_nodedir=${nodejs_24}
    pnpm rebuild --pending "''${pnpmInstallFlags[@]}" \
      --filter '!@t3tools/monorepo' --filter '!@t3tools/desktop'
  '';

  # No package.json script builds just the server (build:desktop's --filter
  # list also builds @t3tools/desktop, which needs Electron). `pnpm exec`
  # resolves vp from node_modules/.bin directly, same as pnpmBuildHook's
  # pnpmBuildScript convention would, without a dedicated package.json script.
  buildPhase = ''
    runHook preBuild
    pnpm exec vp run --filter t3 build
    runHook postBuild
  '';

  # Dependencies include prebuilt artifacts for foreign systems and statically
  # linked executables, which must not be patched or audited as host binaries.
  dontPatchELF = true;
  dontAutoPatchelf = true;
  noAuditTmpdir = true;

  installPhase = ''
    runHook preInstall

    # Deploy an isolated production graph instead of the whole workspace store.
    pnpm --filter t3 deploy --prod --offline "$out/libexec/t3code/apps/server"

    mkdir -p "$out/libexec/t3code/apps/server/dist/resource-monitor/${platformKey}"
    install -Dm755 ${resourceMonitor}/bin/t3-resource-monitor \
      "$out/libexec/t3code/apps/server/dist/resource-monitor/${platformKey}/t3-resource-monitor"

    mkdir -p "$out/bin"
    makeWrapper ${lib.getExe nodejs_24} "$out/bin/t3" \
      --add-flags "$out/libexec/t3code/apps/server/dist/bin.mjs"

    find "$out/libexec/t3code" -xtype l -delete

    runHook postInstall
  '';

  # node-pty's prebuilt binaries don't already have libstdc++ loaded (#10125).
  postFixup = lib.optionalString stdenv.hostPlatform.isLinux ''
    autoPatchelf "$out/libexec/t3code/apps/server/node_modules/node-pty/prebuilds/${platformKey}"
  '';

  postInstall = ''
    for shell in bash fish zsh; do
      installShellCompletion --cmd t3 --"$shell" <("$out/bin/t3" --completions "$shell")
    done
  '';

  doInstallCheck = true;
  nativeInstallCheckInputs = [
    versionCheckHook
    versionCheckHomeHook
  ];
  versionCheckProgramArg = [ "--version" ];

  passthru = {
    category = "AI Coding Agents";
    inherit resourceMonitor;
  };

  meta = {
    description = "Control surface for coding agents (mikenrafter fork)";
    homepage = "https://github.com/mikenrafter/t3code";
    license = lib.licenses.mit;
    sourceProvenance = with lib.sourceTypes; [ fromSource ];
    mainProgram = "t3";
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
      "aarch64-darwin"
    ];
  };
}
