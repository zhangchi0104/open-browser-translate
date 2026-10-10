{
  description = "open-browser-translate dev shell";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "aarch64-darwin"
        "x86_64-linux"
        "aarch64-linux"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # package.json's "packageManager": "bun@X.Y.Z", which CI installs too.
      packageJson = builtins.fromJSON (builtins.readFile ./package.json);
      bunVersion = nixpkgs.lib.removePrefix "bun@" packageJson.packageManager;
    in
    {
      devShells = forAllSystems (pkgs: {
        # NoCC: no compiler wrapper or Apple SDK, so on macOS xcrun and xcodebuild are Xcode's
        # (`bun run build:safari`). The shellHook drops what stdenv still exports, which
        # xcodebuild would otherwise read as build settings.
        default = pkgs.mkShellNoCC {
          packages = with pkgs; [
            bun
            nodejs_24 # semantic-release and commitlint run on Node in CI
            git
            gh
            jq
            curl
            zip
            unzip
            google-cloud-sdk # scripts/setup-chrome-web-store.sh
            nixfmt
          ];

          shellHook = ''
            unset DEVELOPER_DIR SDKROOT MACOSX_DEPLOYMENT_TARGET
            if [ "$(bun --version)" != "${bunVersion}" ]; then
              echo "warning: bun $(bun --version) from nixpkgs, but package.json pins bun@${bunVersion}" >&2
            fi
          '';
        };
      });

      # Fails when nixpkgs' bun drifts from package.json's pin; `nix flake update` or bump the pin.
      checks = forAllSystems (pkgs: {
        bun-version =
          assert pkgs.lib.assertMsg (
            pkgs.bun.version == bunVersion
          ) "nixpkgs has bun ${pkgs.bun.version}, but package.json pins bun@${bunVersion}";
          pkgs.runCommand "bun-version" { } "touch $out";
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}
