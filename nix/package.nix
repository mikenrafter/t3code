{
  callPackage,
  stdenvNoCC,
  makeBinaryWrapper,
  t3code-unwrapped ? callPackage ./unwrapped.nix { },
}:

stdenvNoCC.mkDerivation {
  pname = "t3code";
  inherit (t3code-unwrapped) version;

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

    mkdir -p "$out/bin"

    makeWrapper ${t3code-unwrapped}/bin/t3 "$out/bin/t3"
    ln -s ${t3code-unwrapped}/share "$out/share"

    runHook postInstall
  '';

  passthru = {
    category = "AI Coding Agents";
    inherit (t3code-unwrapped) pnpmDeps resourceMonitor src;
    unwrapped = t3code-unwrapped;
  };

  meta = t3code-unwrapped.meta;
}
