#!/usr/bin/env bash
#
# Submits a release's Chrome zip to the Chrome Web Store for review. semantic-release
# runs it as the last publish step (.releaserc.json), after the GitHub release exists:
#
#   scripts/release/submit-chrome-web-store.sh <version>
#
# - Prereleases (any version with a "-" suffix, e.g. 0.3.0-beta.1) are never submitted.
# - With none of the four CHROME_* secrets set, it skips with a warning on the run.
# - With only some of them set, or when the upload or submission fails, it exits non-zero
#   and fails the release job.
#
# scripts/setup-chrome-web-store.sh sets the secrets up.

set -euo pipefail

version="${1:?usage: $0 <version>}"

if [[ "$version" == *-* ]]; then
  echo "$version is a prerelease; not submitting it to the Chrome Web Store."
  exit 0
fi

required=(CHROME_EXTENSION_ID CHROME_PUBLISHER_ID CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL CHROME_SERVICE_ACCOUNT_PRIVATE_KEY)
missing=()
for name in "${required[@]}"; do
  [[ -n "${!name:-}" ]] || missing+=("$name")
done

if (( ${#missing[@]} == ${#required[@]} )); then
  echo "::warning title=Chrome Web Store skipped::The CHROME_* secrets are not set, so $version was not submitted to the Chrome Web Store. Run scripts/setup-chrome-web-store.sh to set them."
  exit 0
fi
if (( ${#missing[@]} )); then
  echo "::error title=Chrome Web Store::Missing secrets: ${missing[*]}. Set all four or none."
  exit 1
fi

# The v1.1 API shuts down on 2026-10-15; publish-browser-extension still defaults to it.
export CHROME_API_VERSION="${CHROME_API_VERSION:-v2}"

cd "$(dirname "$0")/../../apps/extension"
zip=".output/open-browser-translate-$version-chrome.zip"
if [[ ! -f "$zip" ]]; then
  echo "::error title=Chrome Web Store::apps/extension/$zip not found."
  exit 1
fi

# wxt submit exits 1 when authentication, the upload or the submission fails.
bunx wxt submit --chrome-zip "$zip"
