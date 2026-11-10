#!/bin/sh
# Runs out/test/integration.js in a throwaway VS Code profile (opens a window).
# VSCODE: the Electron binary itself, not the `code` launcher, which detaches.
set -e
cd "$(dirname "$0")/.."
VSCODE=${VSCODE:-/usr/share/code/code}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
npx tsc -p .
FOPS_TEST_LOG=$tmp/log "$VSCODE" --user-data-dir="$tmp/user" --extensions-dir="$tmp/ext" --disable-extensions \
    --skip-welcome --skip-release-notes --extensionDevelopmentPath="$PWD" \
    --extensionTestsPath="$PWD/out/test/integration.js" "$(cd .. && pwd)" >"$tmp/out" 2>&1 && ok=0 || ok=1
cat "$tmp/log" 2>/dev/null || tail -20 "$tmp/out"
exit $ok
