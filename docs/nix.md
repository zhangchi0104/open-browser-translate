# Nix dev shell

`flake.nix` gives a dev shell with everything this repo's tasks, scripts and release steps call:

```bash
nix develop
```

Or, with [direnv](https://direnv.net) and [nix-direnv](https://github.com/nix-community/nix-direnv), `direnv allow` once and the shell loads on `cd` (`.envrc` is `use flake`).

Then work as usual: `bun install`, `bun run compile`, `bun run test`, `bun run build`, `bun run zip`, `bunx commitlint`, and so on. Turborepo, WXT, semantic-release and commitlint come from `bun install`, not Nix.

| Package | For |
| --- | --- |
| `bun` | everything; the same version as `packageManager` in `package.json` |
| `nodejs_24` | semantic-release and commitlint, which CI runs on Node 24 |
| `git`, `gh`, `jq`, `curl`, `zip`, `unzip` | `scripts/release/submit-chrome-web-store.sh`, `scripts/setup-chrome-web-store.sh` |
| `google-cloud-sdk` | `gcloud` in `scripts/setup-chrome-web-store.sh` |
| `nixfmt` | `nix fmt` |

Systems: `aarch64-darwin`, `x86_64-linux`, `aarch64-linux`. nixpkgs drops `x86_64-darwin` in 26.11, so Intel Macs aren't covered.

## Bun version

Bun comes from nixpkgs-unstable, which `flake.lock` pins at a commit whose `bun` matches `package.json`'s `packageManager` (and CI's `bun-version`). `nix flake check` fails when they differ, and the shell warns. When bumping Bun, bump `packageManager` and CI, then `nix flake update`; if nixpkgs doesn't have that version yet, wait for it or override `bun` in the flake.

## macOS and Xcode

The shell is `mkShellNoCC`: no compiler wrapper or Apple SDK, so `xcrun`, `xcodebuild` and `plutil` stay Xcode's and `bun run build:safari` works as outside it (see `docs/safari.md`). Its shellHook unsets `DEVELOPER_DIR`, `SDKROOT` and `MACOSX_DEPLOYMENT_TARGET`, which `xcodebuild` would read as build settings. The shell puts GNU coreutils and `sed` ahead of the macOS ones, so scripts here use flags both understand (`sed -i.bak`, not `sed -i ''`).

## Playwright

Playwright isn't in the shell. nixpkgs' Playwright browsers have to match the npm `playwright` version exactly and aren't built for macOS, so install Playwright with npm and let it download its own Chromium (`npx playwright install chromium`), as `store/chrome/source/render.cjs` says. On NixOS, where downloaded browsers don't run, point `CHROMIUM_PATH` at a Nix `chromium`.

## CI

CI doesn't use the flake; it installs Bun and Node with `oven-sh/setup-bun` and `actions/setup-node`.
