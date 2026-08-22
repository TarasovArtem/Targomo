#!/usr/bin/env bash
# TEMPORARY DIAGNOSTIC SCRIPT - Roadmap #19.7F-B2 / #19.7F-B3.
# Exists only on diagnostic/firefox-poitiles-linux. Runs the real, unchanged
# cypress/e2e/tests/poi_data_requests.cy.js against Firefox on the
# GitHub-hosted ubuntu-latest runner used by this workflow. No AI/provider
# calls anywhere in this file.
#
# #19.7F-B3 sampling change: the previous mode (MAX_ATTEMPTS=15, plus a
# 3x full-suite phase) already answered "does it flake within one runner
# session" - it doesn't, 48/48 clean across 3 runners. The open question is
# now runner-instance variability, so the new default is ONE baseline
# attempt per runner (SINGLE_SHOT_MODE=true unless explicitly overridden),
# maximizing independent-runner coverage for a given amount of external-SUT
# traffic. The old multi-attempt/full-suite capability is preserved behind
# explicit env vars for future debugging, per #19.7F-B3 Phase 3, rather than
# duplicated into a second script.
set -uo pipefail

SINGLE_SHOT_MODE="${SINGLE_SHOT_MODE:-true}"
MAX_ATTEMPTS="${MAX_ATTEMPTS:-1}"
RUN_FULL_SUITE_PHASE="${RUN_FULL_SUITE_PHASE:-false}"
SPEC="cypress/e2e/tests/poi_data_requests.cy.js"
ARTIFACT_ROOT="diagnostic-artifacts"
PACE_SECONDS=7
mkdir -p "$ARTIFACT_ROOT"

if [ "${SINGLE_SHOT_MODE}" = "true" ]; then
  MAX_ATTEMPTS=1
fi

FAILED_ATTEMPT=""
EXACT_SIGNATURE_SEEN=0

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  echo "=== ATTEMPT ${attempt} / ${MAX_ATTEMPTS} ==="
  date -u +"%Y-%m-%dT%H:%M:%SZ"
  echo "--- resource snapshot before attempt ---"
  free -m
  df -h /dev/shm || true
  uptime

  rm -rf reports cypress/screenshots cypress/videos

  set +e
  npx cypress run --spec "$SPEC" --headless --browser firefox >"${ARTIFACT_ROOT}/attempt-${attempt}.log" 2>&1
  EXIT_CODE=$?
  set -e

  cat "${ARTIFACT_ROOT}/attempt-${attempt}.log"
  echo "EXIT_CODE=${EXIT_CODE}"

  mkdir -p "${ARTIFACT_ROOT}/attempt-${attempt}"
  cp -r reports "${ARTIFACT_ROOT}/attempt-${attempt}/reports" 2>/dev/null || true
  cp -r cypress/screenshots "${ARTIFACT_ROOT}/attempt-${attempt}/screenshots" 2>/dev/null || true
  cp -r cypress/videos "${ARTIFACT_ROOT}/attempt-${attempt}/videos" 2>/dev/null || true
  cp "${ARTIFACT_ROOT}/attempt-${attempt}.log" "${ARTIFACT_ROOT}/attempt-${attempt}/terminal.log" 2>/dev/null || true

  if [ "${EXIT_CODE}" -ne 0 ]; then
    if grep -q "poiTiles" "${ARTIFACT_ROOT}/attempt-${attempt}.log" && grep -q "No request ever occurred" "${ARTIFACT_ROOT}/attempt-${attempt}.log"; then
      echo "EXACT_FAILURE_SIGNATURE_MATCHED at attempt ${attempt}"
      FAILED_ATTEMPT="${attempt}"
      EXACT_SIGNATURE_SEEN=1
      break
    else
      echo "NON_MATCHING_FAILURE at attempt ${attempt} - preserving artifacts and stopping baseline loop (not counted as the target signature, classified UNRELATED_DIAGNOSTIC_FAILURE)"
      FAILED_ATTEMPT="${attempt}"
      break
    fi
  fi

  if [ "${attempt}" -lt "${MAX_ATTEMPTS}" ]; then
    echo "Pacing pause before next attempt (${PACE_SECONDS}s, runner-level only, not part of the test itself)"
    sleep "${PACE_SECONDS}"
  fi
done

echo "=== BASELINE LOOP COMPLETE ==="
echo "FAILED_ATTEMPT=${FAILED_ATTEMPT:-none}"
echo "EXACT_SIGNATURE_SEEN=${EXACT_SIGNATURE_SEEN}"
echo "BASELINE_SPEC_UNCHANGED=YES"

if [ "${EXACT_SIGNATURE_SEEN}" -eq 1 ]; then
  echo "############################################################"
  echo "# EXACT HISTORICAL FAILURE REPRODUCED - FORENSIC MODE START #"
  echo "############################################################"

  FAIL_DIR="${ARTIFACT_ROOT}/baseline-failure"
  mkdir -p "${FAIL_DIR}"
  cp -r "${ARTIFACT_ROOT}/attempt-${FAILED_ATTEMPT}/." "${FAIL_DIR}/" 2>/dev/null || true
  echo "Original failure artifacts preserved under ${FAIL_DIR} (never overwritten by anything below)"

  echo "=== Failure-time resource snapshot ==="
  free -m | tee "${FAIL_DIR}/free-m.txt"
  df -h /dev/shm | tee "${FAIL_DIR}/df-shm.txt" || true
  uptime | tee "${FAIL_DIR}/uptime.txt"
  ps aux | tee "${FAIL_DIR}/ps-aux.txt" | grep -iE "firefox|cypress|node" || true

  echo "=== Runner identity / image metadata (safe subset only) ==="
  {
    echo "hostname: $(hostname 2>/dev/null || echo unknown)"
    echo "uname -a: $(uname -a)"
    cat /etc/os-release 2>/dev/null
    echo "ImageOS=${ImageOS:-<unset>}"
    echo "ImageVersion=${ImageVersion:-<unset>}"
    echo "RUNNER_NAME=${RUNNER_NAME:-<unset>}"
    echo "RUNNER_OS=${RUNNER_OS:-<unset>}"
    echo "RUNNER_ARCH=${RUNNER_ARCH:-<unset>}"
    echo "GITHUB_RUN_ID=${GITHUB_RUN_ID:-<unset>}"
    echo "GITHUB_RUN_ATTEMPT=${GITHUB_RUN_ATTEMPT:-<unset>}"
  } | tee "${FAIL_DIR}/runner-identity.txt"

  echo "=== Network environment metadata (safe subset only, no probing) ==="
  {
    echo "--- /etc/resolv.conf ---"
    cat /etc/resolv.conf 2>/dev/null || echo "unavailable"
    echo "--- interface addresses (ip -brief addr) ---"
    ip -brief addr 2>/dev/null || echo "unavailable"
    echo "--- proxy env vars PRESENT (values not dumped) ---"
    for v in http_proxy https_proxy no_proxy HTTP_PROXY HTTPS_PROXY NO_PROXY; do
      if [ -n "${!v:-}" ]; then echo "${v}=<set>"; else echo "${v}=<unset>"; fi
    done
  } | tee "${FAIL_DIR}/network-metadata.txt"

  echo "=== Same-runner unchanged baseline repeat (max 1) - runner-persistence check ==="
  rm -rf reports cypress/screenshots cypress/videos
  set +e
  npx cypress run --spec "$SPEC" --headless --browser firefox >"${FAIL_DIR}/repeat-baseline.log" 2>&1
  REPEAT_CODE=$?
  set -e
  cat "${FAIL_DIR}/repeat-baseline.log"
  echo "REPEAT_BASELINE_EXIT_CODE=${REPEAT_CODE}"
  mkdir -p "${FAIL_DIR}/repeat-baseline"
  cp -r reports "${FAIL_DIR}/repeat-baseline/reports" 2>/dev/null || true
  cp -r cypress/screenshots "${FAIL_DIR}/repeat-baseline/screenshots" 2>/dev/null || true
  if [ "${REPEAT_CODE}" -ne 0 ] && grep -q "poiTiles" "${FAIL_DIR}/repeat-baseline.log" && grep -q "No request ever occurred" "${FAIL_DIR}/repeat-baseline.log"; then
    echo "RUNNER_ASSOCIATED_PERSISTENCE=SUPPORTED (second unchanged baseline on same runner also failed with exact signature)"
  else
    echo "RUNNER_ASSOCIATED_PERSISTENCE=WEAKENED (second unchanged baseline on same runner did not reproduce)"
  fi
  echo "Pacing pause (${PACE_SECONDS}s)"
  sleep "${PACE_SECONDS}"

  echo "=== Failure-time 15000ms requestTimeout diagnostic (max 1, CLI override only) ==="
  rm -rf reports cypress/screenshots cypress/videos
  set +e
  npx cypress run --spec "$SPEC" --headless --browser firefox --config requestTimeout=15000 >"${FAIL_DIR}/timeout-15s.log" 2>&1
  TCODE=$?
  set -e
  cat "${FAIL_DIR}/timeout-15s.log"
  echo "TIMEOUT_15S_EXIT_CODE=${TCODE}"
  mkdir -p "${FAIL_DIR}/timeout-15s"
  cp -r reports "${FAIL_DIR}/timeout-15s/reports" 2>/dev/null || true
  if [ "${TCODE}" -eq 0 ]; then
    echo "REQUEST_INITIATION_LATE=YES (passed once requestTimeout was raised to 15000ms)"
  elif grep -q "No request ever occurred" "${FAIL_DIR}/timeout-15s.log"; then
    echo "REQUEST_INITIATION_LATE=NO (still no request observed even at 15000ms)"
  else
    echo "REQUEST_INITIATION_LATE=INCONCLUSIVE (failed for a different reason)"
  fi
  echo "Pacing pause (${PACE_SECONDS}s)"
  sleep "${PACE_SECONDS}"

  echo "=== Runtime-generated Performance-API resource trace (diagnostic-only spec, never committed) ==="
  TRACE_SPEC="cypress/e2e/tests/__diagnostic_resource_trace.cy.js"
  cat > "${TRACE_SPEC}" <<'SPECEOF'
/// <reference types="cypress" />
// DIAGNOSTIC-ONLY - generated at runtime by Roadmap #19.7F-B3, deleted
// immediately after use, never committed. Not a permanent test. Observes
// performance.getEntriesByType('resource') for a bounded 15s window after
// the same Gastronomy-category trigger the real spec uses, to determine
// whether Firefox emits a semantic .mvt resource at all during a runner
// session where the real test just failed.
import { navigation } from '../pageObjects/navigation.js';
import { categories } from '../pageObjects/categories.js';

function snapshot(label) {
  cy.window().then((win) => {
    const resources = win.performance.getEntriesByType('resource')
      .filter((r) => r.name.includes('pointofinterest') || r.name.includes('.mvt'));
    cy.writeFile(
      'diagnostic-artifacts/baseline-failure/resource-trace.jsonl',
      JSON.stringify({
        label,
        timestamp: new Date().toISOString(),
        matchCount: resources.length,
        resources: resources.map((r) => ({
          name: r.name,
          initiatorType: r.initiatorType,
          startTime: r.startTime,
          duration: r.duration,
          transferSize: r.transferSize,
        })),
      }) + '\n',
      { flag: 'a+' },
    );
  });
}

describe('DIAGNOSTIC ONLY - poiTiles resource trace', () => {
  it('traces performance resource entries around the Gastronomy trigger', () => {
    navigation.navigate();
    cy.intercept('**/pointofinterest/**/*.mvt*').as('poiTiles');
    snapshot('T0-before-click');
    categories.getGastronomy().click();
    snapshot('T1-immediately-after-click');
    cy.wait(2000);
    snapshot('T2-plus-2s');
    cy.wait(3000);
    snapshot('T3-plus-5s');
    cy.wait(3000);
    snapshot('T4-plus-8s');
    cy.wait(4000);
    snapshot('T5-plus-12s');
    cy.wait(3000);
    snapshot('T6-plus-15s');
  });
});
SPECEOF

  set +e
  npx cypress run --spec "${TRACE_SPEC}" --headless --browser firefox >"${FAIL_DIR}/resource-trace-run.log" 2>&1
  TRACE_CODE=$?
  set -e
  cat "${FAIL_DIR}/resource-trace-run.log"
  echo "RESOURCE_TRACE_RUN_EXIT_CODE=${TRACE_CODE}"
  rm -f "${TRACE_SPEC}"
  echo "Diagnostic-only trace spec deleted from workspace (never committed to git)."

  if [ -f "${FAIL_DIR}/resource-trace.jsonl" ]; then
    echo "=== resource-trace.jsonl contents ==="
    cat "${FAIL_DIR}/resource-trace.jsonl"
    if grep -q '"matchCount":0' "${FAIL_DIR}/resource-trace.jsonl" && ! grep -qv '"matchCount":0' "${FAIL_DIR}/resource-trace.jsonl"; then
      echo "BROWSER_SEMANTIC_MVT_REQUEST_ON_FAILURE=NO (zero matching resources across the entire 15s observation window)"
    else
      echo "BROWSER_SEMANTIC_MVT_REQUEST_ON_FAILURE=YES (at least one matching resource observed - see resource-trace.jsonl for exact URL/timing)"
    fi
  else
    echo "BROWSER_SEMANTIC_MVT_REQUEST_ON_FAILURE=UNKNOWN (resource-trace.jsonl was not produced)"
  fi

  echo "############################################################"
  echo "# FORENSIC MODE COMPLETE                                    #"
  echo "############################################################"
fi

if [ "${RUN_FULL_SUITE_PHASE}" = "true" ]; then
  echo "=== FULL-SUITE PHASE (matches production 'npm run firefox' exactly) ==="
  FULL_SUITE_RUNS="${FULL_SUITE_RUNS:-3}"
  for fs in $(seq 1 "$FULL_SUITE_RUNS"); do
    echo "--- full-suite attempt ${fs} / ${FULL_SUITE_RUNS} ---"
    date -u +"%Y-%m-%dT%H:%M:%SZ"
    rm -rf reports cypress/screenshots cypress/videos
    set +e
    npx cypress run --spec "cypress/e2e/**" --headless --browser firefox >"${ARTIFACT_ROOT}/full-suite-${fs}.log" 2>&1
    FCODE=$?
    set -e
    cat "${ARTIFACT_ROOT}/full-suite-${fs}.log"
    echo "FULL_SUITE_${fs}_EXIT_CODE=${FCODE}"
    mkdir -p "${ARTIFACT_ROOT}/full-suite-${fs}"
    cp -r reports "${ARTIFACT_ROOT}/full-suite-${fs}/reports" 2>/dev/null || true
    if [ "${FCODE}" -ne 0 ] && grep -q "poiTiles" "${ARTIFACT_ROOT}/full-suite-${fs}.log" && grep -q "No request ever occurred" "${ARTIFACT_ROOT}/full-suite-${fs}.log"; then
      echo "FULL_SUITE_EXACT_FAILURE_SIGNATURE_MATCHED at full-suite attempt ${fs} - stopping full-suite loop"
      break
    fi
    sleep "${PACE_SECONDS}"
  done
fi

echo "=== DIAGNOSTIC SCRIPT DONE ==="
# Always exit 0: this is an observational diagnostic, not a gate. Job
# conclusion is intentionally decoupled from Cypress's own pass/fail so
# that artifacts always upload regardless of what was observed.
exit 0
