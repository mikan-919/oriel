#!/usr/bin/env bash
set -euo pipefail

# Run from the checkout root. Never print remote URLs or transport diagnostics,
# which can contain authentication data.
if ! result=$(git ls-remote --exit-code origin refs/heads/main 2>/dev/null); then
  echo 'Failed to retrieve main head; deployment blocked.' >&2
  exit 1
fi
if [[ ! "$result" =~ ^([0-9a-f]{40})$'\t'refs/heads/main$ ]]; then
  echo 'Invalid main head response; deployment blocked.' >&2
  exit 1
fi
head_sha=${BASH_REMATCH[1]}
if [[ ! "${DEPLOY_SHA:-}" =~ ^[0-9a-f]{40}$ ]]; then
  echo 'Invalid deployment SHA; deployment blocked.' >&2
  exit 1
fi
if [[ "$head_sha" == "$DEPLOY_SHA" ]]; then
  echo "Deploying main head $DEPLOY_SHA (Relay then Web)."
  echo 'deploy=true' >> "$GITHUB_OUTPUT"
else
  echo "Skipping stale deployment $DEPLOY_SHA; main head is $head_sha."
fi
