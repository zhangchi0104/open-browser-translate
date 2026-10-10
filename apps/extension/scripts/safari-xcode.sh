#!/bin/sh
# Wraps the Safari build (.output/safari-mv3) in a Safari Web Extension Xcode project with macOS
# and iOS apps, at .output/safari-xcode. The project is generated, not committed: it references
# the build's files in place, so rebuild the extension, then build the app again in Xcode; run this
# again when the build gains or loses a top-level file. See docs/safari.md.
set -eu
cd "$(dirname "$0")/.."

extension=.output/safari-mv3
out=.output/safari-xcode
name="Open Browser Translate"
# Safari apps need a reverse-DNS ID; this one follows the Firefox add-on ID, open-browser-translate@zhangchi0104.
bundle_id=io.github.zhangchi0104.open-browser-translate

if [ ! -f "$extension/manifest.json" ]; then
  echo "No Safari build at $extension; run 'wxt build -b safari --mv3' first." >&2
  exit 1
fi
# X.Y.Z, also for betas: WXT keeps the -beta.N suffix to version_name.
version=$(plutil -extract version raw -o - "$extension/manifest.json")

xcrun safari-web-extension-converter "$extension" \
  --project-location "$out" --app-name "$name" --bundle-identifier "$bundle_id" \
  --swift --no-open --no-prompt --force

# The converter starts every app at 1.0. -i.bak works with both BSD sed and GNU sed (Nix dev shell).
pbxproj="$out/$name/$name.xcodeproj/project.pbxproj"
sed -i.bak "s/MARKETING_VERSION = [^;]*;/MARKETING_VERSION = $version;/" "$pbxproj"
rm "$pbxproj.bak"

echo "Xcode project: $out/$name/$name.xcodeproj"
