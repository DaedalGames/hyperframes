set -u
node --import tsx packages/cli/scripts/prepare-process-test-browser.mjs; export HYPERFRAMES_BROWSER_PATH=$(grep HYPERFRAMES_BROWSER_PATH "$GITHUB_ENV" | tail -1 | cut -d= -f2-)
cd packages/cli
r() { npx vitest run "$@" --maxWorkers=1 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E "✓|×|Tests "; }
for i in 1 2 3; do echo "ORPH run $i"; r src/browser/chromeOrphans.process.test.ts; done
echo "WARM+DEADLINE"; r src/warmCheck.process.test.ts src/utils/checkDeadline.process.test.ts
sed -i 's/  if (process.platform !== "win32" || !profile) return undefined;/  return undefined;/' src/browser/windowsChromeWatchdog.ts
echo "MUTANT no watchdog ($(grep -c '^  return undefined;' src/browser/windowsChromeWatchdog.ts))"; r src/browser/chromeOrphans.process.test.ts
