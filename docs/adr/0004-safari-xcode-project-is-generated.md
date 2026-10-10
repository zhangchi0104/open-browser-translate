---
status: accepted
---

# The Safari Xcode project is generated, not committed

Safari loads extensions only from inside a native app. `bun run build:safari` builds the extension for Safari as Manifest V3 and then has `xcrun safari-web-extension-converter` wrap it in an Xcode project with macOS and iOS apps, under `apps/extension/.output/safari-xcode`. The project is regenerated on every Safari build and isn't committed. `apps/extension/scripts/safari-xcode.sh` fixes the bundle ID (`io.github.zhangchi0104.open-browser-translate`) and sets the app version from the manifest. See `docs/safari.md`.

Nothing in the generated project is ours: the apps only tell the reader to turn the extension on, and everything that matters is in the WXT build. Regenerating loses nothing, keeps the version in step with semantic-release, and picks up new top-level files in the build, which the converter lists one by one. A committed project would be about 1,000 lines of `project.pbxproj` changing for reasons unrelated to the extension.

Safari builds as Manifest V3, not WXT's default V2 for Safari: iOS needs a non-persistent background, which V3's service worker is, and V3 matches the Chrome build, so `optional_host_permissions` and `action` behave the same.

## Considered options

- **Commit the converter's output.** Lets the apps be customised (a real onboarding screen, signing settings), but every new top-level file in the build needs a hand edit to the project. Worth revisiting when a release needs signing settings or custom app code; at that point the project would move to its own `apps/safari` and be committed.
- **Copy the build into the project (`--copy-resources`).** Self-contained, but the copy goes stale after every extension build.
