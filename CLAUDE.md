# open-browser-translate

## Repository layout

Bun workspaces run by Turborepo. Run tasks from the root (`bun run compile`, `bun run test`, `bun run zip`, `bun run dev`, `bun run site`); Turborepo runs them in each package and caches results in `.turbo`.
`nix develop` (or direnv's `.envrc`) gives a shell with Bun, Node 24 and the release scripts' CLIs; see `docs/nix.md`.

- `apps/extension`: the browser extension (WXT + React). Its `package.json` version is the release version.
  `bun run build:safari` builds it for Safari and wraps it in a generated Xcode project (macOS + iOS); see `docs/safari.md`.
- `apps/site`: the home page and privacy policy (Vite + React), published to GitHub Pages by `.github/workflows/pages.yml`. The site shows the English policy, `docs/privacy-policy.md`; `docs/privacy-policy.zh-CN.md` is the Chinese version, kept in step by hand.
- `store/chrome`: Chrome Web Store images and the scripts that make them. `docs/chrome-web-store-listing.md` covers the listing.

## Agent skills

### Issue tracker

Issues and specs live in this repo's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

The five default triage labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root, created lazily. See `docs/agents/domain.md`.

## Commits and releases

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat: Translate tables`, `fix(chatgpt): Keep sign-in alive`. CI lints every commit in a PR with commitlint (`commitlint.config.mjs`).

Pushing to `main` runs semantic-release (`.releaserc.json`): `fix`/`perf` → patch, `feat` → minor, `!`/`BREAKING CHANGE:` → major. It bumps `apps/extension/package.json`, updates `CHANGELOG.md`, tags `vX.Y.Z` and attaches the Chrome/Firefox zips to a GitHub release. `chore`, `docs`, `refactor`, `test`, `ci` and `build` commits don't release. Never bump the version by hand. CI's `plan` job works out the version first (`semantic-release --dry-run`), so `build` zips at that version; then `release` and `chrome-web-store` publish those same zips in parallel, to a GitHub release and to the Chrome Web Store. `.github/workflows/chrome-web-store.yml` resubmits any stable tag by hand, run from `main`. `scripts/setup-chrome-web-store.sh` sets up its OIDC access and the variables in the `production` environment. See `docs/chrome-web-store-listing.md` §6.

Pushing to `dev` publishes a beta the same way: it tags `vX.Y.Z-beta.N` and attaches the zips to a GitHub prerelease. Betas never go to the Chrome Web Store. They don't commit anything back to `dev`, so `package.json` and `CHANGELOG.md` on `dev` stay at the last stable release. Betas number from the latest stable tag reachable from `dev`, so after each stable release the `release` job merges that tag back into `dev`. Chrome manifests can't hold `-beta.N`: WXT sets `version` to `X.Y.Z` and `version_name` to the full version, and Firefox gets `X.Y.Z` only. The zip filenames carry the full version.
