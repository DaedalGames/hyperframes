set -u
node --import tsx packages/cli/scripts/prepare-process-test-browser.mjs; export HYPERFRAMES_BROWSER_PATH=$(grep HYPERFRAMES_BROWSER_PATH "$GITHUB_ENV" | tail -1 | cut -d= -f2-)
cd packages/cli
echo "=== WITH WATCHDOG"; npx vitest run src/browser/orphanDebug.debug.test.ts --maxWorkers=1 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v "^\s*$" | grep -A12 "ORPHDBG" | head -80
npx vitest run src/browser/chromeOrphans.process.test.ts --maxWorkers=1 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E -A25 "FAIL|×" | head -70
sed -i 's/  if (process.platform !== "win32" || !profile) return undefined;/  return undefined;/' src/browser/windowsChromeWatchdog.ts
echo "=== WITHOUT WATCHDOG"; npx vitest run src/browser/orphanDebug.debug.test.ts --maxWorkers=1 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -v "^\s*$" | grep -A12 "ORPHDBG" | head -80
