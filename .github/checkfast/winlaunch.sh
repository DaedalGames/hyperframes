set -u
node --import tsx packages/cli/scripts/prepare-process-test-browser.mjs; export HYPERFRAMES_BROWSER_PATH=$(grep HYPERFRAMES_BROWSER_PATH "$GITHUB_ENV" | tail -1 | cut -d= -f2-)
cd packages/cli
r() { npx vitest run src/browser/chromeOrphans.process.test.ts --maxWorkers=1 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|Tests |AssertionError|^\+ "; }
for i in 1 2 3; do echo "=== ORPH run $i"; r; done
cp src/browser/windowsChromeWatchdog.ts /tmp/wd.ts
sed -i 's/      HF_CHROME_SINCE: String(launchedAt),/      HF_CHROME_SINCE: String(launchedAt + 3_600_000),/' src/browser/windowsChromeWatchdog.ts
echo "=== MUTANT start time in the future ($(grep -c '3_600_000' src/browser/windowsChromeWatchdog.ts))"; r
cp /tmp/wd.ts src/browser/windowsChromeWatchdog.ts
sed -i 's/  if (!executable || chrome.pid === undefined) return undefined;/  return undefined;/' src/browser/windowsChromeWatchdog.ts
echo "=== MUTANT no watchdog ($(grep -c '^  return undefined;$' src/browser/windowsChromeWatchdog.ts))"; r
