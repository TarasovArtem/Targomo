#!/usr/bin/env bash
# TEMPORARY DIAGNOSTIC SCRIPT - Roadmap #19.7F-B2.
# Exists only on diagnostic/firefox-poitiles-linux. Runs the real, unchanged
# cypress/e2e/tests/poi_data_requests.cy.js sequentially against Firefox on
# the GitHub-hosted ubuntu-latest runner used by this workflow, bounded and
# paced to avoid hammering the public external SUT. No AI/provider calls.
set -uo pipefail

MAX_ATTEMPTS="${MAX_ATTEMPTS:-15}"
SPEC="cypress/e2e/tests/poi_data_requests.cy.js"
ARTIFACT_ROOT="diagnostic-artifacts"
PACE_SECONDS=7
mkdir -p "$ARTIFACT_ROOT"

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
      echo "NON_MATCHING_FAILURE at attempt ${attempt} - preserving artifacts and stopping baseline loop (not counted as the target signature)"
      FAILED_ATTEMPT="${attempt}"
      break
    fi
  fi

  echo "Pacing pause before next attempt (${PACE_SECONDS}s, runner-level only, not part of the test itself)"
  sleep "${PACE_SECONDS}"
done

echo "=== BASELINE LOOP COMPLETE ==="
echo "FAILED_ATTEMPT=${FAILED_ATTEMPT:-none}"
echo "EXACT_SIGNATURE_SEEN=${EXACT_SIGNATURE_SEEN}"

if [ "${EXACT_SIGNATURE_SEEN}" -eq 1 ]; then
  echo "=== Running 15000ms requestTimeout diagnostic (up to 5 attempts, CLI override only, cypress.config.js untouched) ==="
  for t in 1 2 3 4 5; do
    echo "--- requestTimeout=15000 attempt ${t} ---"
    date -u +"%Y-%m-%dT%H:%M:%SZ"
    rm -rf reports cypress/screenshots cypress/videos
    set +e
    npx cypress run --spec "$SPEC" --headless --browser firefox --config requestTimeout=15000 >"${ARTIFACT_ROOT}/timeout-attempt-${t}.log" 2>&1
    TCODE=$?
    set -e
    cat "${ARTIFACT_ROOT}/timeout-attempt-${t}.log"
    echo "TIMEOUT_ATTEMPT_${t}_EXIT_CODE=${TCODE}"
    mkdir -p "${ARTIFACT_ROOT}/timeout-attempt-${t}"
    cp -r reports "${ARTIFACT_ROOT}/timeout-attempt-${t}/reports" 2>/dev/null || true
    cp "${ARTIFACT_ROOT}/timeout-attempt-${t}.log" "${ARTIFACT_ROOT}/timeout-attempt-${t}/terminal.log" 2>/dev/null || true
    echo "Pacing pause (${PACE_SECONDS}s)"
    sleep "${PACE_SECONDS}"
  done
fi

echo "=== FULL-SUITE PHASE (matches production 'npm run firefox' exactly: all 3 specs in one continuous cypress run) ==="
# Every one of the 7 historical CI failures occurred with
# poi_data_requests.cy.js running as the SECOND spec inside one continuous
# `cypress run --spec 'cypress/e2e/**'` process (category_tree_behavior.cy.js
# passes first, then poi_data_requests.cy.js fails) - never in isolation.
# The targeted-only loop above never tests that exact invocation shape, so
# this phase reproduces it directly, bounded to 3 repetitions per the
# mission's own full-suite cap.
FULL_SUITE_RUNS=3
for fs in $(seq 1 "$FULL_SUITE_RUNS"); do
  echo "--- full-suite attempt ${fs} / ${FULL_SUITE_RUNS} ---"
  date -u +"%Y-%m-%dT%H:%M:%SZ"
  free -m
  df -h /dev/shm || true

  rm -rf reports cypress/screenshots cypress/videos

  set +e
  npx cypress run --spec "cypress/e2e/**" --headless --browser firefox >"${ARTIFACT_ROOT}/full-suite-${fs}.log" 2>&1
  FCODE=$?
  set -e

  cat "${ARTIFACT_ROOT}/full-suite-${fs}.log"
  echo "FULL_SUITE_${fs}_EXIT_CODE=${FCODE}"

  mkdir -p "${ARTIFACT_ROOT}/full-suite-${fs}"
  cp -r reports "${ARTIFACT_ROOT}/full-suite-${fs}/reports" 2>/dev/null || true
  cp -r cypress/screenshots "${ARTIFACT_ROOT}/full-suite-${fs}/screenshots" 2>/dev/null || true
  cp -r cypress/videos "${ARTIFACT_ROOT}/full-suite-${fs}/videos" 2>/dev/null || true
  cp "${ARTIFACT_ROOT}/full-suite-${fs}.log" "${ARTIFACT_ROOT}/full-suite-${fs}/terminal.log" 2>/dev/null || true

  if [ "${FCODE}" -ne 0 ] && grep -q "poiTiles" "${ARTIFACT_ROOT}/full-suite-${fs}.log" && grep -q "No request ever occurred" "${ARTIFACT_ROOT}/full-suite-${fs}.log"; then
    echo "FULL_SUITE_EXACT_FAILURE_SIGNATURE_MATCHED at full-suite attempt ${fs} - stopping full-suite loop"
    break
  fi

  echo "Pacing pause before next full-suite attempt (${PACE_SECONDS}s)"
  sleep "${PACE_SECONDS}"
done

echo "=== DIAGNOSTIC SCRIPT DONE ==="
# Always exit 0: this is an observational diagnostic, not a gate. Job
# conclusion is intentionally decoupled from Cypress's own pass/fail so
# that artifacts always upload regardless of what was observed.
exit 0
