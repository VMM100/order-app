#!/usr/bin/env bash
# Runs the rules tests in the Firestore emulator. If anything fails, the last lines of output are
# posted as an annotation on the GitHub run, since logs aren't always easy to reach.
set -o pipefail
npx firebase emulators:exec --only firestore --project demo-order-app \
  "node --test --test-reporter=./reporter.mjs rules.test.mjs" 2>&1 | tee out.txt
code=${PIPESTATUS[0]}
if [ "$code" != "0" ]; then
  tail -n 60 out.txt | grep -v '^::' | sed 's/%/%25/g' | awk 'BEGIN{ORS="%0A"} {print}' > tail.txt
  echo "::warning title=Last output::$(cat tail.txt)"
fi
exit $code
