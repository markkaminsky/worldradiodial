#!/usr/bin/env python3
"""Generate an ambient bed — the segment that lets an hour end exactly on the cycle.

The director places whole segments until nothing more fits and gives the remainder to
a bed, because a bed is the only thing that can be cut at an arbitrary sample without
sounding cut. With no bed in the pool that remainder is silence, which is how you ship
an hour with two dead minutes at the end of it.

Synthesised rather than sourced: it is then unambiguously ours, costs nothing, and can
be regenerated at any length. Every partial is an INTEGER number of cycles over the
bed's duration, so the end meets the beginning exactly and repeats are seamless —
which matters because the bed is looped to fill whatever gap it is handed.
"""
import math, os, struct, sys, wave
from array import array

RATE, CH = 44100, 2
SECS = float(sys.argv[1]) if len(sys.argv) > 1 else 180.0
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "bed.wav")

n = int(SECS * RATE)
buf = array("h", bytes(2 * CH * n))

# A slow minor-ish stack, detuned by a hair so it never sits still. Integer cycle
# counts keep the loop seamless; the detune is applied by choosing a NEIGHBOURING
# integer rather than a fractional offset, which would break the seam.
base = 55.0  # A1
partials = []
for mult, amp in [(1, 0.30), (2, 0.16), (3, 0.10), (4, 0.06), (6, 0.045), (8, 0.03)]:
    for cents in (0, +7):
        f = base * mult * (2 ** (cents / 1200.0))
        cycles = max(1, round(f * SECS))
        partials.append((cycles / SECS, amp * (0.6 if cents else 1.0)))

# Two very slow amplitude drifts, also integer-cycle, so the texture breathes.
drift = [(round(SECS / 23) / SECS, 0.35), (round(SECS / 37) / SECS, 0.22)]

for i in range(n):
    t = i / RATE
    env = 1.0
    for f, d in drift:
        env *= 1.0 - d + d * 0.5 * (1 + math.sin(2 * math.pi * f * t))
    v = 0.0
    for f, a in partials:
        v += a * math.sin(2 * math.pi * f * t)
    v *= env * 0.30
    # A gentle stereo spread: the same field, delayed a touch on one side.
    l = max(-1.0, min(1.0, v))
    r = max(-1.0, min(1.0, v * 0.92 + 0.08 * math.sin(2 * math.pi * partials[2][0] * t)))
    buf[i * CH] = int(l * 32000)
    buf[i * CH + 1] = int(r * 32000)

# Integer cycle counts get the partials to meet, but the drift envelopes and the
# stereo offset do not land as neatly, and the residual step is audible as a click
# every time the bed loops. Rather than chase the arithmetic, fold the tail back over
# the head: crossfade the last `X` seconds into the first `X` and drop them. The seam
# then cannot exist, whatever the maths did.
X = min(4.0, SECS / 8)
xn = int(X * RATE)
for k in range(xn):
    g = k / xn
    for c in range(CH):
        head_i = k * CH + c
        tail_i = (n - xn + k) * CH + c
        buf[head_i] = int(buf[head_i] * g + buf[tail_i] * (1 - g))
del buf[(n - xn) * CH:]
n -= xn

with wave.open(OUT, "wb") as w:
    w.setnchannels(CH); w.setsampwidth(2); w.setframerate(RATE)
    w.writeframes(buf.tobytes())

# The seam is the whole point — report it rather than assume it, and measure the right
# thing. Comparing a window at the head against a window at the tail says nothing: two
# distant points in a moving waveform have no reason to match, and a loop is seamless
# when the WRAP looks like any other neighbouring pair of samples. So compare the step
# across the wrap against the distribution of ordinary steps inside the file.
wrap = max(abs(buf[c] - buf[(n - 1) * CH + c]) for c in range(CH))
steps = sorted(abs(buf[k * CH] - buf[(k - 1) * CH]) for k in range(1, n, 97))
p99 = steps[int(len(steps) * 0.99)]
verdict = "seamless" if wrap <= p99 else f"AUDIBLE ({wrap / max(1, p99):.1f}x normal)"
print(f"wrote {OUT}  {n / RATE:.1f}s  wrap step {wrap} vs 99th-pct step {p99} — {verdict}")
