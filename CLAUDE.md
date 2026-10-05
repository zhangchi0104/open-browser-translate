# open-browser-translate

## Repository layout

Bun workspaces run by Turborepo. Run tasks from the root (`bun run compile`, `bun run test`, `bun run zip`, `bun run dev`, `bun run site`); Turborepo runs them in each package and caches results in `.turbo`.

- `apps/extension`: the browser extension (WXT + React). Its `package.json` version is the release version.
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

Pushing to `main` runs semantic-release (`.releaserc.json`): `fix`/`perf` → patch, `feat` → minor, `!`/`BREAKING CHANGE:` → major. It bumps `apps/extension/package.json`, updates `CHANGELOG.md`, tags `vX.Y.Z` and attaches the Chrome/Firefox zips to a GitHub release. `chore`, `docs`, `refactor`, `test`, `ci` and `build` commits don't release. Never bump the version by hand.
