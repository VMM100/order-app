#!/usr/bin/env bash
# The print box end to end, inside the database and sign-in emulators (see tests/print-e2e.mjs).
set -o pipefail
cd "$(dirname "$0")/.."
node_modules/.bin/firebase emulators:exec --only firestore,auth --project demo-order-app \
  "node tests/print-e2e.mjs" 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tee out.txt
code=${PIPESTATUS[0]}
if [ "$code" != "0" ]; then
  tail -n 60 out.txt | grep -v '^::' | sed 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print}' > tail.txt
  echo "::warning title=Print box test output::$(cat tail.txt)"
fi
exit $code
