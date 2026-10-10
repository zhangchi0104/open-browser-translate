# Safari

The extension runs in Safari on macOS, iOS and iPadOS as a Safari Web Extension: the same WXT build, wrapped in a small native app that Safari loads it from. There's no Safari release yet; this covers building and running it locally.

## Build

On a Mac with Xcode:

```bash
bun run build:safari
```

That builds `apps/extension/.output/safari-mv3` (`wxt build -b safari --mv3`) and then runs `apps/extension/scripts/safari-xcode.sh`, which wraps it with `xcrun safari-web-extension-converter` in an Xcode project at `apps/extension/.output/safari-xcode/Open Browser Translate/Open Browser Translate.xcodeproj`. The project has a macOS app and an iOS/iPadOS app, each with its extension.

- Bundle ID: `io.github.zhangchi0104.open-browser-translate` (the extension is `….Extension`), after the Firefox add-on ID.
- The app's version is the extension's (`MARKETING_VERSION`); the build number stays 1.
- The project references the build's files where they are rather than copying them. After changing the extension, build it again and rebuild the app in Xcode. If the build gains or loses a top-level file or folder, run `bun run build:safari` again to regenerate the project.
- The project is generated, so it isn't committed (see ADR-0004). Signing settings made in Xcode are lost when it's regenerated.

From the command line, without Xcode's UI:

```bash
xcodebuild -project "apps/extension/.output/safari-xcode/Open Browser Translate/Open Browser Translate.xcodeproj" -scheme "Open Browser Translate (macOS)" -configuration Debug -derivedDataPath apps/extension/.output/safari-dd build
```

```bash
xcodebuild -project "apps/extension/.output/safari-xcode/Open Browser Translate/Open Browser Translate.xcodeproj" -scheme "Open Browser Translate (iOS)" -configuration Debug -sdk iphonesimulator -destination "generic/platform=iOS Simulator" -derivedDataPath apps/extension/.output/safari-dd build
```

There's no `dev:safari`: WXT's dev server can't load into Safari, so rebuild instead.

## Run on macOS

1. In Safari, turn on Settings → Advanced → "Show features for web developers", then Develop → "Allow Unsigned Extensions" (asks for your password; Safari turns it off again when it quits). Builds signed with your own Apple developer team don't need this.
2. Run the macOS scheme in Xcode (or open the `.app` that `xcodebuild` built in `.output/safari-dd/Build/Products/Debug`). The app only says where to turn the extension on.
3. Safari → Settings → Extensions: turn on Open Browser Translate.
4. Safari asks for website access the first time the extension is used on a site. Choose "Always Allow on Every Website" so the launcher appears everywhere; host access can also be changed later on the same settings page.

## Run on iOS and iPadOS

1. Build and run the iOS scheme on a simulator or device. A device needs a development team in the app's and extension's Signing & Capabilities.
2. Settings → Apps → Safari → Extensions → Open Browser Translate: turn it on and set "All Websites" to Allow. (On older iOS: Settings → Safari → Extensions.)
3. In Safari, the extension's settings are under the page menu (the `⋯`/`AA` button) → Open Browser Translate, which opens the settings page in a new tab. The launcher appears on web pages as on the desktop.

A simulator reaches servers on the Mac at `127.0.0.1`, so a custom connection to a local OpenAI-compatible server works there.

To try a build without a model provider, run `bun apps/extension/scripts/mock-openai.ts` and add a custom connection with API URL `http://127.0.0.1:8787/v1`, model `mock-translator` and any key; translations come back as the original text marked `[译] `.

## Differences from Chrome and Firefox

- **Manifest V3, Safari 16.4 or later.** Session storage (used by the ChatGPT sign-in) needs 16.4; `browser_specific_settings.safari.strict_min_version` says so. The converter's iOS app targets iOS 17, so in practice iOS 17+.
- **Website access is the reader's choice.** Safari grants no host access at install, including the hosts the manifest lists. Until the reader allows a site, the launcher doesn't appear there.
- **Sign in with ChatGPT** asks for access to `auth.openai.com` and `127.0.0.1` when the reader clicks Sign in: the background has to see the loopback callback tab's URL. Chrome and Firefox granted these at install, so they return at once there. Not yet tried end to end on Safari.
- **Custom connections** ask for their server's origin on save, as in Chrome.
- **Model providers' CORS.** If Safari applies CORS to background requests to a host the reader hasn't allowed, Vercel AI Gateway and OpenAI requests could fail until the extension is allowed on those hosts. Not yet seen; allowing the extension on every website avoids it.
- **The toolbar button** opens the settings page, as elsewhere. On iOS the button is in Safari's page menu.

## Releasing (not set up)

What a Safari release would need, beyond this:

- An Apple Developer Program team, with the app, extension and bundle IDs registered in App Store Connect.
- Signing in CI: a distribution certificate and provisioning profiles for the macOS and iOS apps (or `xcodebuild -allowProvisioningUpdates` with an App Store Connect API key), stored as secrets in the `production` environment.
- A CI job on a macOS runner after `plan`: `bun run build:safari`, then `xcodebuild archive` and `-exportArchive` for each platform, then upload with `xcrun altool`/`notary` or the App Store Connect API. The build number (`CURRENT_PROJECT_VERSION`) would need to increase with every upload.
- App Store listings, screenshots and review notes, like `docs/chrome-web-store-listing.md`. The privacy policy already covers what the extension sends; Safari doesn't change that.
