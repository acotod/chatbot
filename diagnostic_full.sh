#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"

MODE="smoke"
RUN_STAGING="auto"

usage() {
  cat <<'EOF'
Usage: ./diagnostic_full.sh [--full] [--staging] [--no-staging]

Options:
  --full         Run complete Jest suite after smoke suite.
  --staging      Force staging E2E flow validation.
  --no-staging   Skip staging E2E flow validation.

Defaults:
  - Smoke validations only for Jest tests.
  - Staging validation runs automatically if sshpass is available.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --full)
      MODE="full"
      shift
      ;;
    --staging)
      RUN_STAGING="yes"
      shift
      ;;
    --no-staging)
      RUN_STAGING="no"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      usage
      exit 2
      ;;
  esac
done

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0

print_header() {
  echo
  echo "============================================================"
  echo "$1"
  echo "============================================================"
}

run_check() {
  local name="$1"
  local cmd="$2"

  echo
  echo "[CHECK] $name"
  if bash -lc "$cmd"; then
    echo "[PASS] $name"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "[FAIL] $name"
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

skip_check() {
  local name="$1"
  local reason="$2"
  echo
  echo "[SKIP] $name - $reason"
  SKIP_COUNT=$((SKIP_COUNT + 1))
}

print_header "CHATBOT FULL DIAGNOSTIC"
echo "Root: $ROOT_DIR"
echo "Mode: $MODE"
echo "Staging: $RUN_STAGING"

run_check "Docker services status" "cd '$ROOT_DIR' && docker compose ps"
run_check "Local API health endpoint" "cd '$ROOT_DIR' && curl -fsS -m 10 http://127.0.0.1:3200/health >/dev/null"
run_check "Local admin login" "cd '$ROOT_DIR' && curl -fsS -m 10 -X POST http://127.0.0.1:3200/auth/login -H 'content-type: application/json' -H 'x-tab-id: diag-full' -d '{\"email\":\"admin@pmc.com\",\"password\":\"FacturaPMC2026\",\"tabId\":\"diag-full\"}' | grep -q 'accessToken'"

print_header "AUTOMATED TESTS"
run_check "Smoke: flowNavigation" "cd '$ROOT_DIR' && npm test -- flowNavigation.test.js --runInBand"
run_check "Smoke: nodeExecutors root cause" "cd '$ROOT_DIR' && npm test -- nodeExecutors.root-cause.test.js --runInBand"
run_check "Smoke: chatbotRouter" "cd '$ROOT_DIR' && npm test -- chatbotRouter.test.js --runInBand"
run_check "Smoke: auth.facebook" "cd '$ROOT_DIR' && npm test -- auth.facebook.test.js --runInBand"

if [[ "$MODE" == "full" ]]; then
  run_check "Full Jest suite" "cd '$ROOT_DIR' && npm test -- --runInBand"
fi

print_header "STAGING E2E"
if [[ "$RUN_STAGING" == "no" ]]; then
  skip_check "Staging horario diagnostic" "disabled by --no-staging"
else
  if [[ "$RUN_STAGING" == "yes" ]]; then
    run_check "Staging horario diagnostic" "cd '$ROOT_DIR' && ./diag_horario_staging.sh"
  else
    if command -v sshpass >/dev/null 2>&1; then
      run_check "Staging horario diagnostic" "cd '$ROOT_DIR' && ./diag_horario_staging.sh"
    else
      skip_check "Staging horario diagnostic" "sshpass not installed"
    fi
  fi
fi

print_header "SUMMARY"
echo "PASS: $PASS_COUNT"
echo "FAIL: $FAIL_COUNT"
echo "SKIP: $SKIP_COUNT"

if [[ $FAIL_COUNT -gt 0 ]]; then
  echo "VERDICT=FAIL"
  exit 1
fi

echo "VERDICT=PASS"
exit 0
