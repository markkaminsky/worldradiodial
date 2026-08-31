#!/usr/bin/env python3
"""Render one hour of Gamma's own station, and optionally publish it.

Run it daily and the station is different every day. Run it never and the station
still works — it just repeats. That is the whole design: the app knows a URL and a
cycle length, nothing else, so the content behind them can change forever without an
app release.

    python3 build_hour.py                 # render only
    python3 build_hour.py --upload        # render and replace the published asset
    python3 build_hour.py --seed 20260901 # reproduce a specific day

Why exactly 3600 seconds, always: the app seeks to `now mod cycle`, and the cycle is
baked into its bundle. Render 3601 and every listener is a second out of step with the
schedule, drifting further all day. The length is a contract, not a detail.

macOS only, and deliberately dependency-free — afconvert ships with the OS, so this
needs no ffmpeg and no pip install to run on a schedule.
"""
import argparse, glob, hashlib, os, random, subprocess, sys, wave
from array import array
from datetime import date

RATE, CH, CYCLE = 44100, 2, 3600
HERE = os.path.dirname(os.path.abspath(__file__))
TAG = "radio-gamma-one"
ASSET = "gamma-hour.m4a"
REPO = "markkaminsky/worldradiodial"

DEFAULT_SOURCES = [
    os.path.expanduser("~/Library/Mobile Documents/com~apple~CloudDocs/Toyota*.mp3"),
]


def decode(src, dst):
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", str(CH), src, dst],
                   check=True, capture_output=True)


def fade(buf, frames, into):
    n = min(frames, len(buf) // CH)
    for i in range(n):
        g = (i / n) if into else (1 - i / n)
        base = i * CH if into else (len(buf) // CH - 1 - i) * CH
        for c in range(CH):
            buf[base + c] = int(buf[base + c] * g)


def gather(patterns):
    """Every distinct track, deduplicated by content rather than by filename."""
    found, seen = [], set()
    for pat in patterns:
        for p in sorted(glob.glob(os.path.expanduser(pat))):
            h = hashlib.md5(open(p, "rb").read()).hexdigest()
            if h in seen:
                continue
            seen.add(h)
            found.append(p)
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", default=date.today().strftime("%Y%m%d"),
                    help="run order is derived from this; same seed, same hour")
    ap.add_argument("--source", action="append", default=None,
                    help="glob of audio to draw from; repeatable")
    ap.add_argument("--upload", action="store_true",
                    help="replace the published release asset (needs gh auth)")
    args = ap.parse_args()

    tracks = gather(args.source or DEFAULT_SOURCES)
    if not tracks:
        sys.exit("no source audio found")

    # The order is the only thing that changes day to day, and it is seeded so a given
    # day's hour can always be rebuilt exactly.
    rng = random.Random(args.seed)
    rng.shuffle(tracks)
    print(f"seed {args.seed} — {len(tracks)} tracks")

    out, cue = array("h"), []
    i = 0
    need = CYCLE * RATE * CH
    while len(out) < need:
        src = tracks[i % len(tracks)]
        i += 1
        wav = os.path.join(HERE, "_t.wav")
        decode(src, wav)
        with wave.open(wav) as w:
            buf = array("h")
            buf.frombytes(w.readframes(w.getnframes()))
        os.remove(wav)
        fade(buf, RATE // 5, True)
        fade(buf, RATE // 5, False)
        cue.append((len(out) // CH / RATE, os.path.basename(src)))
        out.extend(buf)

    del out[need:]
    # Fade the seam so the top of the hour is not a click.
    fade(out, 3 * RATE, False)

    wav = os.path.join(HERE, "_hour.wav")
    with wave.open(wav, "wb") as w:
        w.setnchannels(CH); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(out.tobytes())

    m4a = os.path.join(HERE, ASSET)
    if os.path.exists(m4a):
        os.remove(m4a)
    subprocess.run(["afconvert", "-f", "m4af", "-d", f"aac@{RATE}", "-b", "128000", wav, m4a],
                   check=True)
    os.remove(wav)

    with open(os.path.join(HERE, "cue.txt"), "w") as f:
        f.write(f"# seed {args.seed}\n")
        for t, n in cue:
            if t < CYCLE:
                f.write(f"{int(t//60):02d}:{int(t%60):02d}  {n}\n")

    secs = len(out) // CH / RATE
    print(f"rendered {secs:.3f}s -> {ASSET} ({os.path.getsize(m4a)//1024//1024} MB)")
    if abs(secs - CYCLE) > 0.001:
        sys.exit(f"REFUSING: {secs}s is not the {CYCLE}s the app expects")

    if args.upload:
        # Same tag, same filename, therefore same URL. Replacing the asset is what makes
        # this a schedule rather than a migration.
        subprocess.run(["gh", "release", "delete-asset", TAG, ASSET, "-y", "-R", REPO],
                       capture_output=True)
        subprocess.run(["gh", "release", "upload", TAG, m4a, "--clobber", "-R", REPO],
                       check=True)
        print(f"published: https://github.com/{REPO}/releases/download/{TAG}/{ASSET}")


if __name__ == "__main__":
    main()
