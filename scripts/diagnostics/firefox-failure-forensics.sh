#!/usr/bin/env bash
# TEMPORARY - Roadmap #19.7F-B4B (Firefox stability investigation).
#
# Runs ONLY after the ORIGINAL, unmodified `npm run firefox` production
# execution has already failed (the workflow step invoking this script is
# gated on steps.run_tests.outcome == 'failure'). Everything below is
# diagnostic-only and can NEVER change the production Firefox job's
# pass/fail result - that result is already fixed by the original run
# before this script starts, and this script always exits 0.
#
# Historical context: 7/47 (~14.9%) organic Firefox CI runs have failed with
# poi_data_requests.cy.js / cy.wait('@poiTiles') / "No request ever
# occurred". Static/historical forensics (#19.7F-B4A) found no runner
# image, Firefox version, Cypress version, or workflow-definition
# differentiator between failing and passing runs. The only remaining
# evidence source is an organic failure captured with instrumentation
# attached - this script is that instrumentation.
#
# Removal: delete this file and the two workflow steps in
# .github/workflows/cypress.yml that reference it once Firefox root cause
# is captured/confirmed, or the investigation is explicitly closed.
set -uo pipefail

FORENSICS_ROOT="reports/firefox-forensics"
SPEC="cypress/e2e/tests/poi_data_requests.cy.js"

mkdir -p "${FORENSICS_ROOT}/original" "${FORENSICS_ROOT}/metadata"

echo "=== #19.7F-B4B: preserving ORIGINAL failure evidence before any forensic rerun ==="
{
  echo "original_step_outcome=failure"
  echo "preserved_at_utc=$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
} > "${FORENSICS_ROOT}/metadata/original-result.txt"

# Copy (never move) - the existing, unmodified "Upload Cypress
# screenshots"/"Upload structured test report"/"Upload Cypress videos"
# steps already ran, unchanged, before this step and already uploaded the
# primary cypress-screenshots-firefox/cypress-report-firefox/
# cypress-videos-firefox artifacts. This is a redundant convenience copy
# bundled into the same forensics artifact, not the sole copy.
cp -r reports/cypress "${FORENSICS_ROOT}/original/reports-cypress" 2>/dev/null || true
cp -r cypress/screenshots "${FORENSICS_ROOT}/original/screenshots" 2>/dev/null || true
cp -r cypress/videos "${FORENSICS_ROOT}/original/videos" 2>/dev/null || true

echo "=== Post-failure resource snapshot ==="
{
  date -u +"%Y-%m-%dT%H:%M:%SZ"
  echo "--- free -m ---"
  free -m
  echo "--- df -h /dev/shm ---"
  df -h /dev/shm || true
  echo "--- uptime ---"
  uptime
  echo "--- ps (firefox/cypress/node processes) ---"
  ps aux | grep -iE "firefox|cypress|node" || true
} >"${FORENSICS_ROOT}/metadata/post-failure-resources.txt"
cat "${FORENSICS_ROOT}/metadata/post-failure-resources.txt"

echo "=== Runner/runtime identity (safe subset only, no secrets) ==="
{
  echo "ImageOS=${ImageOS:-<unset>}"
  echo "ImageVersion=${ImageVersion:-<unset>}"
  echo "RUNNER_OS=${RUNNER_OS:-<unset>}"
  echo "RUNNER_ARCH=${RUNNER_ARCH:-<unset>}"
  echo "GITHUB_RUN_ID=${GITHUB_RUN_ID:-<unset>}"
  echo "GITHUB_SHA=${GITHUB_SHA:-<unset>}"
  uname -a
} >"${FORENSICS_ROOT}/metadata/runner-identity.txt"
cat "${FORENSICS_ROOT}/metadata/runner-identity.txt"

echo "=== Same-runner unchanged repeat (max 1 attempt, diagnostic only - does NOT affect production result) ==="
rm -rf reports cypress/screenshots cypress/videos
set +e
npx cypress run --spec "$SPEC" --headless --browser firefox >"${FORENSICS_ROOT}/same-runner-repeat.log" 2>&1
REPEAT_CODE=$?
set +e
cat "${FORENSICS_ROOT}/same-runner-repeat.log"
mkdir -p "${FORENSICS_ROOT}/same-runner-repeat"
cp "${FORENSICS_ROOT}/same-runner-repeat.log" "${FORENSICS_ROOT}/same-runner-repeat/terminal.log" 2>/dev/null || true
cp -r reports/cypress "${FORENSICS_ROOT}/same-runner-repeat/reports-cypress" 2>/dev/null || true
cp -r cypress/screenshots "${FORENSICS_ROOT}/same-runner-repeat/screenshots" 2>/dev/null || true
rm -f "${FORENSICS_ROOT}/same-runner-repeat.log"

if [ "${REPEAT_CODE}" -eq 0 ]; then
  echo "same_runner_repeat_result=PASS" >>"${FORENSICS_ROOT}/metadata/original-result.txt"
elif grep -q "No request ever occurred" "${FORENSICS_ROOT}/same-runner-repeat/terminal.log" 2>/dev/null; then
  echo "same_runner_repeat_result=FAIL_SAME_SIGNATURE" >>"${FORENSICS_ROOT}/metadata/original-result.txt"
else
  echo "same_runner_repeat_result=FAIL_DIFFERENT_SIGNATURE" >>"${FORENSICS_ROOT}/metadata/original-result.txt"
fi

echo "=== 15000ms requestTimeout diagnostic (max 1 attempt, CLI override only, cypress.config.js untouched) ==="
rm -rf reports cypress/screenshots cypress/videos
set +e
npx cypress run --spec "$SPEC" --headless --browser firefox --config requestTimeout=15000 >"${FORENSICS_ROOT}/request-timeout-15s.log" 2>&1
TIMEOUT_CODE=$?
set +e
cat "${FORENSICS_ROOT}/request-timeout-15s.log"
mkdir -p "${FORENSICS_ROOT}/request-timeout-15s"
cp "${FORENSICS_ROOT}/request-timeout-15s.log" "${FORENSICS_ROOT}/request-timeout-15s/terminal.log" 2>/dev/null || true
cp -r reports/cypress "${FORENSICS_ROOT}/request-timeout-15s/reports-cypress" 2>/dev/null || true
rm -f "${FORENSICS_ROOT}/request-timeout-15s.log"

if [ "${TIMEOUT_CODE}" -eq 0 ]; then
  echo "requesttimeout_15s_result=PASS_REQUEST_APPEARED_LATE" >>"${FORENSICS_ROOT}/metadata/original-result.txt"
elif grep -q "No request ever occurred" "${FORENSICS_ROOT}/request-timeout-15s/terminal.log" 2>/dev/null; then
  echo "requesttimeout_15s_result=FAIL_STILL_NO_REQUEST" >>"${FORENSICS_ROOT}/metadata/original-result.txt"
else
  echo "requesttimeout_15s_result=FAIL_DIFFERENT_SIGNATURE" >>"${FORENSICS_ROOT}/metadata/original-result.txt"
fi

echo "=== Browser Performance Resource Timing trace (diagnostic-only spec, generated now, deleted before job ends, never committed) ==="
TRACE_SPEC="cypress/e2e/tests/__firefox_forensics_trace.cy.js"
cat >"${TRACE_SPEC}" <<'SPECEOF'
/// <reference types="cypress" />
// TEMPORARY DIAGNOSTIC SPEC - generated at runtime by the #19.7F-B4B
// forensics script, deleted before the job ends, never committed to git.
// Not a permanent test. Observes performance.getEntriesByType('resource')
// for a bounded window after the same Gastronomy-category trigger the real
// spec uses, and separately registers the same semantic intercept matcher
// to compare browser-visible resources against what Cypress itself
// observes - WITHOUT failing on cy.wait, since the goal here is
// observation, not assertion.
import { navigation } from '../pageObjects/navigation.js';
import { categories } from '../pageObjects/categories.js';

function sanitizedSnapshot(label, getCypressCount) {
  cy.window().then((win) => {
    const resources = win.performance.getEntriesByType('resource');
    const mvt = resources.filter(
      (r) => r.name.includes('pointofinterest') && r.name.includes('.mvt'),
    );
    // Sanitized, derived fields only - never the raw URL or query string.
    const derived = mvt.map((r) => ({
      isPoiTile: true,
      pathClass: 'pointofinterest-mvt',
      initiatorType: r.initiatorType,
      startTimeMs: Math.round(r.startTime),
      durationMs: Math.round(r.duration),
      transferSize: typeof r.transferSize === 'number' ? r.transferSize : null,
    }));
    cy.writeFile(
      'reports/firefox-forensics/resource-trace/trace.jsonl',
      JSON.stringify({
        label,
        timestamp: new Date().toISOString(),
        browserMvtResourceCount: mvt.length,
        cypressInterceptObserved: getCypressCount() > 0,
        cypressInterceptCount: getCypressCount(),
        resources: derived,
      }) + '\n',
      { flag: 'a+' },
    );
  });
}

describe('TEMPORARY #19.7F-B4B forensic trace (not a permanent test)', () => {
  it('compares browser-visible mvt resources against the Cypress intercept', () => {
    let cypressCount = 0;
    const getCypressCount = () => cypressCount;
    navigation.navigate();
    cy.intercept('**/pointofinterest/**/*.mvt*', () => {
      cypressCount += 1;
    }).as('poiTilesTrace');
    sanitizedSnapshot('T0-before-click', getCypressCount);
    categories.getGastronomy().click();
    sanitizedSnapshot('T1-immediately-after-click', getCypressCount);
    cy.wait(3000).then(() => sanitizedSnapshot('T2-plus-3s', getCypressCount));
    cy.wait(4000).then(() => sanitizedSnapshot('T3-plus-7s', getCypressCount));
    cy.wait(4000).then(() => sanitizedSnapshot('T4-plus-11s', getCypressCount));
    cy.wait(4000).then(() => sanitizedSnapshot('T5-plus-15s', getCypressCount));
  });
});
SPECEOF

mkdir -p "${FORENSICS_ROOT}/resource-trace"
rm -rf reports cypress/screenshots cypress/videos
set +e
npx cypress run --spec "${TRACE_SPEC}" --headless --browser firefox >"${FORENSICS_ROOT}/resource-trace/terminal.log" 2>&1
TRACE_RUN_CODE=$?
set +e
cat "${FORENSICS_ROOT}/resource-trace/terminal.log"
echo "resource_trace_run_exit_code=${TRACE_RUN_CODE}" >>"${FORENSICS_ROOT}/metadata/original-result.txt"

rm -f "${TRACE_SPEC}"
echo "Diagnostic-only trace spec deleted from workspace (never committed to git)."

if [ -f "${FORENSICS_ROOT}/resource-trace/trace.jsonl" ]; then
  echo "browser_resource_trace_supported=YES" >>"${FORENSICS_ROOT}/metadata/original-result.txt"
else
  echo "browser_resource_trace_supported=UNKNOWN" >>"${FORENSICS_ROOT}/metadata/original-result.txt"
fi

echo "=== Privacy sanitization pass: scanning every generated forensic file for sensitive patterns ==="
SENSITIVE_PATTERN='(authorization|bearer|token|apikey|api_key|secret|cookie|set-cookie)'
FLAGGED=0
while IFS= read -r -d '' f; do
  if grep -Eiq "${SENSITIVE_PATTERN}" "$f" 2>/dev/null; then
    echo "SENSITIVE_PATTERN_FOUND in $f - removing file from forensics output"
    rm -f "$f"
    FLAGGED=1
  fi
done < <(find "${FORENSICS_ROOT}" -type f -print0)
echo "privacy_scan_flagged_files_removed=${FLAGGED}" >>"${FORENSICS_ROOT}/metadata/original-result.txt"

echo "=== #19.7F-B4B forensics complete ==="
# Always exit 0: diagnostic-only. The production Firefox job's pass/fail
# result was already fixed by the ORIGINAL `npm run firefox` execution,
# which ran and completed long before this script started.
exit 0
