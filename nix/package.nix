{
  lib,
  callPackage,
  stdenvNoCC,
  makeBinaryWrapper,
  t3code-unwrapped ? callPackage ./unwrapped.nix { },
}:

stdenvNoCC.mkDerivation {
  pname = "t3code";
  inherit (t3code-unwrapped) version;

  outputs = [
    "out"
    "desktop"
  ];

  dontUnpack = true;
  strictDeps = true;

  nativeBuildInputs = [ makeBinaryWrapper ];

  # No PATH-prefixing for other agent CLIs (codex/claude-code/cursor-agent/...)
  # here on purpose: t3code assumes whatever agent binaries it shells out to
  # are already on PATH, which scout-modules/ai-cli provides system-wide on
  # any host that also enables it. Keeps this flake's only dependency on the
  # agent-CLI world to "PATH has to have them," not a Nix-level one.
  installPhase = ''
    runHook preInstall

    mkdir -p "$out/bin" "$desktop/bin"

    makeWrapper ${t3code-unwrapped}/bin/t3 "$out/bin/t3"
    ln -s ${t3code-unwrapped}/share "$out/share"

    makeWrapper ${t3code-unwrapped.desktop}/bin/t3code-desktop \
      "$desktop/bin/t3code-desktop" \
      --inherit-argv0
    ln -s ${t3code-unwrapped.desktop}/share "$desktop/share"

    ${lib.optionalString stdenvNoCC.hostPlatform.isDarwin ''
      sourceApp=${lib.escapeShellArg "${t3code-unwrapped.desktop}/Applications/${t3code-unwrapped.appName}.app"}
      targetApp="$desktop/Applications/${t3code-unwrapped.appName}.app"
      mkdir -p "$targetApp/Contents/MacOS"
      ln -s "$sourceApp/Contents/Info.plist" "$targetApp/Contents/Info.plist"
      ln -s "$sourceApp/Contents/Resources" "$targetApp/Contents/Resources"
      ln -s ../../../../bin/t3code-desktop \
        "$targetApp/Contents/MacOS/${t3code-unwrapped.appName}"
    ''}

    runHook postInstall
  '';

  passthru = {
    category = "AI Coding Agents";
    inherit (t3code-unwrapped) pnpmDeps resourceMonitor src;
    unwrapped = t3code-unwrapped;
  };

  meta = t3code-unwrapped.meta;
}
