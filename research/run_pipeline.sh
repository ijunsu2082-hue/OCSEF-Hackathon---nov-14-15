#!/usr/bin/env bash
# One-command research data pipeline:
#   tests -> fetch -> validate -> manifest -> publish (dry run) -> manifest --check.
#
#   research/run_pipeline.sh                      # full run, publish is a dry run
#   research/run_pipeline.sh --skip-fetch         # validate what is already in clean/ and layers/
#   research/run_pipeline.sh --refresh            # fetchers re-download raw files
#   research/run_pipeline.sh --publish            # also copy layers to public/layers/ (new names only)
#   GENERATED_AT=2026-11-14 research/run_pipeline.sh   # pin the manifest timestamp
#
# Extra arguments are passed to `python -m pipeline all`.
set -euo pipefail

RESEARCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${RESEARCH_DIR}/.venv/bin/python"
GENERATED_AT="${GENERATED_AT:-$(date -u +%Y-%m-%d)}"

if [[ ! -x "${PY}" ]]; then
  echo "run_pipeline: missing interpreter ${PY}" >&2
  exit 1
fi

cd "${RESEARCH_DIR}"
export PYTHONPATH="${RESEARCH_DIR}"

echo "run_pipeline: unit tests"
"${PY}" -m unittest discover -s "${RESEARCH_DIR}/tests"

echo "run_pipeline: pipeline all (generated_at=${GENERATED_AT})"
"${PY}" -m pipeline all --generated-at "${GENERATED_AT}" "$@"

echo "run_pipeline: manifest --check"
"${PY}" -m pipeline manifest --check
