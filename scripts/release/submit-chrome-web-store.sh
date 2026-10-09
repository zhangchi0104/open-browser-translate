#!/usr/bin/env bash
#
# Submits a release's Chrome zip to the Chrome Web Store for review through the Chrome Web
# Store API v2. CI's chrome-web-store job runs it when main releases, and the Chrome Web
# Store workflow (.github/workflows/chrome-web-store.yml) by hand, once the zip is in
# apps/extension/.output:
#
#   scripts/release/submit-chrome-web-store.sh <version>
#
#   CHROME_EXTENSION_ID, CHROME_PUBLISHER_ID  the store item
#   CHROME_ACCESS_TOKEN                       OAuth token for the linked service account, with
#                                             the https://www.googleapis.com/auth/chromewebstore
#                                             scope; the workflows get it through GitHub OIDC
#   DRY_RUN=true                              only check access to the item; upload nothing
#   CHROME_CANCEL_PENDING=true                cancel a version still in review, then submit
#
# Prereleases (any version with a "-" suffix, e.g. 0.3.0-beta.1) are never submitted. Any
# API error, or an upload the store doesn't accept, exits non-zero and fails the run.
#
# scripts/setup-chrome-web-store.sh sets up the service account and the workflow's access.

set -euo pipefail

version="${1:?usage: $0 <version>}"

if [[ "$version" == *-* ]]; then
  echo "$version is a prerelease; not submitting it to the Chrome Web Store."
  exit 0
fi

for name in CHROME_EXTENSION_ID CHROME_PUBLISHER_ID CHROME_ACCESS_TOKEN; do
  if [[ -z "${!name:-}" ]]; then
    echo "::error title=Chrome Web Store::$name is not set."
    exit 1
  fi
done

api="https://chromewebstore.googleapis.com"
item="publishers/$CHROME_PUBLISHER_ID/items/$CHROME_EXTENSION_ID"
zip="$(cd "$(dirname "$0")/../.." && pwd)/apps/extension/.output/open-browser-translate-$version-chrome.zip"

# call METHOD PATH [curl args…] prints the response body. On a non-2xx status it prints the
# error to stderr (callers capture stdout) and fails.
call() {
  local method="$1" path="$2" body status
  shift 2
  body=$(mktemp)
  status=$(curl -sS -o "$body" -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer $CHROME_ACCESS_TOKEN" "$@" "$api$path") || {
    echo "::error title=Chrome Web Store::$method $path failed: no response." >&2
    return 1
  }
  if [[ "$status" != 2* ]]; then
    { echo "::error title=Chrome Web Store::$method $path returned HTTP $status."; cat "$body"; echo; } >&2
    return 1
  fi
  cat "$body"
}

describe() {
  jq -r '"  published: \(.publishedItemRevisionStatus.state // "none") \(.publishedItemRevisionStatus.distributionChannels[0].crxVersion // "")",
         "  in review: \(.submittedItemRevisionStatus.state // "none") \(.submittedItemRevisionStatus.distributionChannels[0].crxVersion // "")"'
}

echo "Checking access to $item"
status=$(call GET "/v2/$item:fetchStatus")
describe <<<"$status"

if [[ "${DRY_RUN:-false}" == true ]]; then
  echo "Dry run: the workflow can reach the item. Nothing was uploaded."
  exit 0
fi

if [[ ! -f "$zip" ]]; then
  echo "::error title=Chrome Web Store::$zip not found."
  exit 1
fi

if [[ "${CHROME_CANCEL_PENDING:-false}" == true ]] &&
  [[ "$(jq -r '.submittedItemRevisionStatus.state // ""' <<<"$status")" == PENDING_REVIEW ]]; then
  echo "Cancelling the version in review"
  call POST "/v2/$item:cancelSubmission" -H "Content-Type: application/json" -d '{}' >/dev/null
fi

echo "Uploading $(basename "$zip")"
upload=$(call POST "/upload/v2/$item:upload" -T "$zip")
state=$(jq -r '.uploadState // ""' <<<"$upload")
# Large packages are processed asynchronously; fetchStatus reports when they're done.
for _ in $(seq 30); do
  [[ "$state" == IN_PROGRESS || "$state" == UPLOAD_IN_PROGRESS ]] || break
  sleep 10
  state=$(call GET "/v2/$item:fetchStatus" | jq -r '.lastAsyncUploadState // ""')
done
if [[ "$state" != SUCCEEDED ]]; then
  echo "::error title=Chrome Web Store::The upload ended in state '${state:-unknown}'. The store rejects a version that isn't higher than the last upload."
  echo "$upload"
  exit 1
fi

echo "Submitting for review"
publish=$(call POST "/v2/$item:publish" -H "Content-Type: application/json" -d '{}')
jq -r '"  state: \(.state // "unknown")", (.warningInfo.warnings[]? | "::warning title=Chrome Web Store::\(.reason): \(.description)")' <<<"$publish"
echo "Submitted $version."
