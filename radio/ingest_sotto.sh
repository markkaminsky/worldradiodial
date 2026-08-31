#!/bin/bash
# Take whatever SottoVoice has rendered and put it on Gamma One.
#
# SottoVoice is the talking engine — local Chatterbox/Kokoro, four-voice casts, overlapping
# turns, unmatched levels. It already produces the hard part. This is only the seam: new
# renders land in its `generated/` directory, and this walks them into the station pool as
# `talk` segments so the format clock can place them between records.
#
# Deduplication is by content hash inside station.py, so re-running this is free and a
# render that has already been ingested is skipped rather than duplicated.
#
#   ./ingest_sotto.sh            # ingest only
#   ./ingest_sotto.sh --publish  # ingest, rebuild the hour, push it live
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="${SOTTO_GENERATED:-$HOME/Documents/SottoVoice/poc/generated}"

if [ ! -d "$SRC" ]; then
  echo "no SottoVoice renders at $SRC" >&2
  exit 1
fi

shopt -s nullglob
found=0
for f in "$SRC"/*.wav; do
  base="$(basename "$f")"
  # Bench and smoke output are test rigs, not programming.
  case "$base" in
    smoke-*|bench-*|_*) continue ;;
  esac
  found=$((found + 1))
  python3 "$HERE/station.py" add "$f" --type talk --title "${base%.wav}"
done
shopt -u nullglob

if [ "$found" -eq 0 ]; then
  echo "nothing to ingest"
  exit 0
fi

python3 "$HERE/station.py" list

if [ "${1:-}" = "--publish" ]; then
  "$HERE/publish.sh"
fi
