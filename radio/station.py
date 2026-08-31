#!/usr/bin/env python3
"""Gamma One's programme director.

Three ideas, and the third is the one that makes it work.

1. A POOL of typed segments — tracks, talk, interludes, idents, stingers, beds —
   each with a real measured duration. Content is added to the pool by whatever
   worker made it; the pool does not care where anything came from.

2. A FORMAT CLOCK. The hour is assembled by walking a repeating pattern of types
   rather than shuffling a folder, which is the difference between a radio station
   and a playlist on random.

3. A BED AT THE END. The cycle length is a contract — the app seeks to `now mod
   cycle`, so a render of 3601s puts every listener a second out of step and
   drifting further all day. Songs cannot be trimmed to make an hour come out
   exactly; a bed can, because it is ambient and loopable and can be cut at any
   sample without sounding cut. So the director places whole segments until the
   remainder is too small for one, then fills the rest with bed. That is also
   what "milking the time" means in practice.

Nothing here repeats within `--cooldown` cycles, which is what stops a listener
hearing the same thing twice in a session — with a deep enough pool that
guarantee is absolute rather than statistical.

    python3 station.py add ~/Music/*.mp3 --type track
    python3 station.py build --cycle 3600
    python3 station.py selftest

macOS only and deliberately dependency-free: afconvert ships with the OS, so this
runs on a schedule with nothing installed.
"""
import argparse, glob, hashlib, json, os, random, subprocess, sys, wave
from array import array
from datetime import date, datetime, timezone

RATE, CH = 44100, 2
HERE = os.path.dirname(os.path.abspath(__file__))
POOL = os.path.join(HERE, "pool")
MANIFEST = os.path.join(POOL, "manifest.json")

TYPES = ["track", "talk", "interlude", "link", "ident", "stinger", "bed"]

# What the hour sounds like. Walked in order and repeated; a type with nothing
# available is skipped rather than stalling the build, so a station with no voice
# recordings yet still assembles.
FORMAT_CLOCK = [
    "ident", "track", "track", "link", "track",
    "stinger", "track", "talk", "track", "track",
    "link", "interlude", "track", "ident", "track",
]


# ————————————————————————————— pool —————————————————————————————

def load_manifest():
    if not os.path.exists(MANIFEST):
        return {"segments": []}
    with open(MANIFEST) as f:
        return json.load(f)


def save_manifest(m):
    os.makedirs(POOL, exist_ok=True)
    with open(MANIFEST, "w") as f:
        json.dump(m, f, indent=2)


def decode_to_wav(src, dst):
    subprocess.run(["afconvert", "-f", "WAVE", "-d", f"LEI16@{RATE}", "-c", str(CH), src, dst],
                   check=True, capture_output=True)


def wav_seconds(path):
    with wave.open(path) as w:
        return w.getnframes() / w.getframerate()


def cmd_add(args):
    m = load_manifest()
    known = {s["sha"] for s in m["segments"]}
    os.makedirs(os.path.join(POOL, args.type), exist_ok=True)
    added = 0
    for pattern in args.files:
        for src in sorted(glob.glob(os.path.expanduser(pattern))):
            sha = hashlib.sha1(open(src, "rb").read()).hexdigest()[:16]
            if sha in known:
                print(f"  already in pool: {os.path.basename(src)}")
                continue
            rel = os.path.join(args.type, f"{sha}.wav")
            dst = os.path.join(POOL, rel)
            decode_to_wav(src, dst)
            secs = wav_seconds(dst)
            m["segments"].append({
                "sha": sha, "type": args.type, "file": rel,
                "seconds": round(secs, 3),
                "title": args.title or os.path.splitext(os.path.basename(src))[0],
                "usedAt": [],
            })
            known.add(sha)
            added += 1
            print(f"  + {args.type:9} {secs/60:5.2f} min  {os.path.basename(src)[:44]}")
    save_manifest(m)
    print(f"{added} added; pool now {len(m['segments'])} segments")


def cmd_list(args):
    m = load_manifest()
    if not m["segments"]:
        print("pool is empty — add something with `station.py add`")
        return
    for t in TYPES:
        seg = [s for s in m["segments"] if s["type"] == t]
        if not seg:
            continue
        total = sum(s["seconds"] for s in seg)
        print(f"{t:10} {len(seg):3} segments  {total/60:7.1f} min total")


# ————————————————————————————— director —————————————————————————————

def choose(pool_by_type, kind, now, cooldown_secs, need_max=None):
    """Least-recently-used segment of `kind` that is out of cooldown and fits."""
    cands = pool_by_type.get(kind, [])
    if need_max is not None:
        cands = [s for s in cands if s["seconds"] <= need_max]
    if not cands:
        return None
    fresh = [s for s in cands
             if not s["usedAt"] or (now - max(s["usedAt"])) > cooldown_secs]
    # Cooldown is a preference, not a wall: a pool too shallow to honour it should
    # still produce an hour, just a less varied one.
    pick_from = fresh or cands
    return min(pick_from, key=lambda s: (max(s["usedAt"]) if s["usedAt"] else 0))


def plan(manifest, cycle, now, cooldown_secs):
    """Return (segments_in_order, seconds_of_bed_fill). Never exceeds `cycle`."""
    by_type = {}
    for s in manifest["segments"]:
        by_type.setdefault(s["type"], []).append(s)

    order, used, i = [], 0.0, 0
    guard = 0
    while guard < 10000:
        guard += 1
        remaining = cycle - used
        if remaining <= 0.05:
            break
        kind = FORMAT_CLOCK[i % len(FORMAT_CLOCK)]
        i += 1
        # Reserve nothing: a segment is placed only if it fits whole.
        seg = choose(by_type, kind, now, cooldown_secs, need_max=remaining)
        if seg is None:
            # Nothing of this type fits or exists. If NOTHING at all fits, stop and
            # let the bed take the remainder.
            anything = any(
                choose(by_type, k, now, cooldown_secs, need_max=remaining)
                for k in TYPES if k != "bed"
            )
            if not anything:
                break
            continue
        order.append(seg)
        used += seg["seconds"]
        seg["usedAt"] = (seg["usedAt"] + [now])[-8:]
    return order, max(0.0, cycle - used)


# ————————————————————————————— render —————————————————————————————

def read_pcm(path):
    with wave.open(path) as w:
        a = array("h")
        a.frombytes(w.readframes(w.getnframes()))
        return a


def fade(buf, frames, into):
    n = min(frames, len(buf) // CH)
    for k in range(n):
        g = (k / n) if into else (1 - k / n)
        base = k * CH if into else (len(buf) // CH - 1 - k) * CH
        for c in range(CH):
            buf[base + c] = int(buf[base + c] * g)


def cmd_build(args):
    m = load_manifest()
    if not m["segments"]:
        sys.exit("pool is empty — add audio with `station.py add` first")
    cycle = args.cycle
    now = datetime.now(timezone.utc).timestamp()
    order, bed_secs = plan(m, cycle, now, args.cooldown * cycle)

    print(f"cycle {cycle}s — {len(order)} segments + {bed_secs:.1f}s bed fill")
    out = array("h")
    for s in order:
        buf = read_pcm(os.path.join(POOL, s["file"]))
        fade(buf, RATE // 8, True)
        fade(buf, RATE // 8, False)
        out.extend(buf)

    # The bed absorbs whatever is left, looped and cut to the exact sample. This is
    # the only segment allowed to be cut, and the only reason the total can land on
    # the cycle exactly.
    need = int(round(cycle * RATE)) * CH - len(out)
    if need > 0:
        beds = [s for s in m["segments"] if s["type"] == "bed"]
        if beds:
            bed = read_pcm(os.path.join(POOL, beds[0]["file"]))
            filler = array("h")
            while len(filler) < need:
                filler.extend(bed)
            del filler[need:]
            fade(filler, RATE // 4, True)
            out.extend(filler)
        else:
            # No bed yet: silence rather than a wrong-length file. The contract with
            # the app matters more than the last few seconds sounding good.
            out.extend(array("h", [0]) * need)
    elif need < 0:
        del out[need:]

    total = len(out) // CH / RATE
    if abs(total - cycle) > 0.002:
        sys.exit(f"REFUSING: assembled {total:.4f}s, not {cycle}s")

    fade(out, 3 * RATE, False)
    wav = os.path.join(HERE, "_hour.wav")
    with wave.open(wav, "wb") as w:
        w.setnchannels(CH); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(out.tobytes())

    m4a = os.path.join(HERE, args.out)
    if os.path.exists(m4a):
        os.remove(m4a)
    subprocess.run(["afconvert", "-f", "m4af", "-d", f"aac@{RATE}", "-b", str(args.bitrate),
                    wav, m4a], check=True)
    os.remove(wav)
    save_manifest(m)

    with open(os.path.join(HERE, "cue.txt"), "w") as f:
        t = 0.0
        for s in order:
            f.write(f"{int(t//60):02d}:{int(t%60):02d}  {s['type']:9} {s['title'][:50]}\n")
            t += s["seconds"]
        if bed_secs > 0.05:
            f.write(f"{int(t//60):02d}:{int(t%60):02d}  bed       (fill)\n")

    print(f"rendered exactly {total:.3f}s -> {args.out} "
          f"({os.path.getsize(m4a)//1024//1024} MB)")


# ————————————————————————————— checks —————————————————————————————

def cmd_selftest(args):
    """The director's promises, checked against synthetic pools."""
    fails = []

    def check(name, cond):
        print(("  ok   " if cond else "  FAIL ") + name)
        if not cond:
            fails.append(name)

    def seg(t, secs, i):
        return {"sha": f"{t}{i}", "type": t, "file": "x", "seconds": secs,
                "title": f"{t}{i}", "usedAt": []}

    # A plan never exceeds the cycle, whatever the segment lengths.
    for trial in range(200):
        rnd = random.Random(trial)
        man = {"segments": [seg(t, rnd.uniform(3, 400), i)
                            for t in TYPES for i in range(rnd.randint(0, 6))]}
        order, bed = plan(man, 3600, 1_000_000.0, 3600 * 3)
        total = sum(s["seconds"] for s in order)
        if total > 3600 + 1e-6 or bed < -1e-6 or abs(total + bed - 3600) > 1e-6:
            check(f"trial {trial}: total {total:.2f} + bed {bed:.2f}", False)
            break
    else:
        check("200 random pools: segments never exceed the cycle, bed closes the gap", True)

    # An empty pool asks the bed for the whole hour rather than looping forever.
    order, bed = plan({"segments": []}, 3600, 0.0, 0)
    check("empty pool terminates and asks the bed for the full cycle",
          order == [] and abs(bed - 3600) < 1e-9)

    # Cooldown is honoured while it can be, and abandoned rather than failing.
    man = {"segments": [seg("track", 100, i) for i in range(3)]}
    now = 1_000_000.0
    for s in man["segments"]:
        s["usedAt"] = [now - 10]
    order, _ = plan(man, 300, now, 3600)
    check("a pool entirely in cooldown still produces an hour", len(order) > 0)

    # Least-recently-used really is least-recently-used.
    man = {"segments": [seg("track", 100, i) for i in range(3)]}
    man["segments"][0]["usedAt"] = [now - 5]
    man["segments"][1]["usedAt"] = [now - 500]
    man["segments"][2]["usedAt"] = []
    first = choose({"track": man["segments"]}, "track", now, 3600, need_max=1000)
    check("never-used segment is chosen before any used one", first["sha"] == "track2")

    # A segment longer than the remaining time is never placed.
    man = {"segments": [seg("track", 5000, 0), seg("bed", 30, 0)]}
    order, bed = plan(man, 3600, now, 0)
    check("an oversized segment is refused rather than truncated",
          all(s["seconds"] <= 3600 for s in order))

    print("\nselftest: " + ("PASSED" if not fails else f"{len(fails)} FAILED"))
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    a = sub.add_parser("add", help="import audio into the pool")
    a.add_argument("files", nargs="+")
    a.add_argument("--type", required=True, choices=TYPES)
    a.add_argument("--title", default=None)
    a.set_defaults(fn=cmd_add)

    l = sub.add_parser("list", help="what is in the pool")
    l.set_defaults(fn=cmd_list)

    b = sub.add_parser("build", help="assemble one cycle")
    b.add_argument("--cycle", type=float, default=3600)
    b.add_argument("--cooldown", type=float, default=3,
                   help="cycles a segment must sit out before reuse")
    b.add_argument("--bitrate", type=int, default=128000)
    b.add_argument("--out", default="gamma-hour.m4a")
    b.set_defaults(fn=cmd_build)

    t = sub.add_parser("selftest", help="check the director's promises")
    t.set_defaults(fn=cmd_selftest)

    args = ap.parse_args()
    sys.exit(args.fn(args) or 0)


if __name__ == "__main__":
    main()
