#!/bin/bash
# Rebuild Gamma One's hour and republish it, in one step.
#
# Run daily rather than hourly. The file is an hour long and the app is seeked into
# whatever is behind the URL, so replacing it while someone is listening risks a
# stall or a jump mid-track. Daily, in the small hours, nobody is mid-listen.
#
# The push is a FORCE push onto a single-commit history on purpose: the audio is a
# 57 MB binary that changes completely every time, so keeping history would add 57 MB
# a day forever and blow the repository limit inside a month.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOST="${GAMMA_HOST_DIR:-$HOME/.gamma-radio-host}"
REPO="https://github.com/markkaminsky/gamma-radio.git"

echo "[$(date -u +%FT%TZ)] building"
python3 "$HERE/station.py" build --cycle 3600 --out gamma-hour.m4a

# station.py refuses to write anything that is not exactly the cycle length, so if we
# got here the file is the right duration. Check it survived anyway — a truncated
# upload is worse than no upload.
SECS=$(afinfo "$HERE/gamma-hour.m4a" | awk '/estimated duration/ {print $3}')
python3 - "$SECS" <<'PY'
import sys
s = float(sys.argv[1])
if abs(s - 3600) > 0.05:
    sys.exit(f"refusing to publish: {s}s is not 3600s")
PY

mkdir -p "$HOST"
cd "$HOST"
if [ ! -d .git ]; then
  git init -q -b main
  git remote add origin "$REPO"
  cat > index.html <<'HTML'
<!doctype html><meta charset=utf-8><title>Gamma One</title>
<p>Static audio host for Gamma One, a station on the Gamma dial.</p>
HTML
fi
cp "$HERE/gamma-hour.m4a" ./gamma-hour.m4a
git add -A
git -c user.email=markkaminsky99@gmail.com -c user.name="Mark Kaminsky" \
    commit -q --amend -m "Gamma One: the rolling hour ($(date -u +%F))" 2>/dev/null \
  || git -c user.email=markkaminsky99@gmail.com -c user.name="Mark Kaminsky" \
       commit -q -m "Gamma One: the rolling hour ($(date -u +%F))"
git push -q --force origin main
echo "[$(date -u +%FT%TZ)] published"
