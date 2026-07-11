#!/usr/bin/env bash
set -euo pipefail

# Validate the canonical compose configuration using temporary, non-sensitive secret files.
# This script does not reuse .env.example as secret material.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

TEMP_DIR="$(mktemp -d)"
# shellcheck disable=SC2317
cleanup() {
  rm -rf "${TEMP_DIR}"
}
trap cleanup EXIT

mkdir -p "${TEMP_DIR}/secrets"
DEPLOYMENT_MASTER_KEY_FILE="${TEMP_DIR}/secrets/deployment-master-key"
BOOTSTRAP_SECRET_FILE="${TEMP_DIR}/secrets/bootstrap-secret"

od -An -tx1 -N 32 /dev/urandom | tr -d ' \n' > "${DEPLOYMENT_MASTER_KEY_FILE}"
head -c 64 /dev/urandom | base64 > "${BOOTSTRAP_SECRET_FILE}"

SESSION_SECRET="$(head -c 64 /dev/urandom | base64)"

export DEPLOYMENT_MASTER_KEY_FILE
export BOOTSTRAP_SECRET_FILE
export SESSION_SECRET
export PUBLIC_BASE_URL="https://collab.example"
export WEBAUTHN_RP_ID="collab.example"
export BACKUP_DIR="/backups"

exec docker compose -f "${REPO_ROOT}/compose.yaml" config --quiet
