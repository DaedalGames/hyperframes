set -u
node --import tsx packages/cli/scripts/prepare-process-test-browser.mjs; export HYPERFRAMES_BROWSER_PATH=$(grep HYPERFRAMES_BROWSER_PATH "$GITHUB_ENV" | tail -1 | cut -d= -f2-)
cd packages/cli
for i in 1 2 3; do echo "=== ORPH run $i"; npx vitest run src/browser/chromeOrphans.process.test.ts --maxWorkers=1 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|Tests |AssertionError|Error:|^\+ " ; done
sed -i 's/  if (!executable || chrome.pid === undefined) return undefined;/  return undefined;/' src/browser/windowsChromeWatchdog.ts
echo "=== MUTANT no watchdog ($(grep -c '^  return undefined;$' src/browser/windowsChromeWatchdog.ts))"; npx vitest run src/browser/chromeOrphans.process.test.ts --maxWorkers=1 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|Tests |AssertionError|^\+ "
