# Gamma One — recording script

Lines for Kyrie to read. Recorded by you, they cost nothing and can never be a licensing
problem — which is the whole reason they are not synthesised. `GammaVoice` speaking on the
device is fine; baking a synthesised voice into a file we publish is a different thing.

## How to read them

The register is already set by `GammaVoice.swift` and worth matching: **a British-booth
announcer who takes a very small operation extremely seriously.** Unhurried, dry, slightly
too formal for what is actually happening. The commas are breath marks, not grammar —
`"You're listening, to Gamma"` has a beat in the middle and that beat is most of the effect.

Two rules the existing lines follow and these keep:

- The joke is never at Gamma's expense. Nothing that says the station is small, unwatched,
  or a poor use of anyone's time.
- The joke is never at the listener's expense.

Practical: phone voice memo is fine. Record in a quiet room, a foot back from the mic, and
leave a full second of silence at the top and tail of every take — the silence is what lets
these be dropped between tracks without clipping. One line per file.

## Station IDs — the backbone

1. "You're listening, to Gamma One."
2. "Gamma One. Everything you hear here, we made."
3. "This is Gamma One. The house station."
4. "Gamma One... broadcasting from a room."
5. "You've found Gamma One. Nobody else is playing this."

## Between tracks

6. "That was ours. So is this."
7. "More of the same. Which is the point."
8. "Gamma One. Still going."
9. "Nothing after this but more of it."
10. "We have exactly one format, and you are hearing it."

## Dry ones — deadpan, no wink

11. "Our playlist is not curated. It is simply everything we have."
12. "Gamma One. No requests, no phone-in, no adverts. We are not being brave, there is just nobody here to answer."
13. "Every hour on Gamma One is a different hour. We checked."
14. "You have joined this in the middle. Everyone does."
15. "Gamma One. Broadcasting continuously, in the sense that the file is quite long."

## The almost-content-free ones — say very little, land the most

16. "Gamma One."
17. "Still here."
18. "Keep it here."
19. "This one's worth staying for."
20. "Somewhere, it's raining."

## Time and daypart

21. "It's late. Gamma One."
22. "Morning. You're on Gamma One."
23. "Whatever hour this is... Gamma One."
24. "The night shift has the dial. Gamma One."

## Sign-offs

25. "That's Gamma One. It starts again in a moment."
26. "Gamma One. We'll be exactly here."

## Where they go

Drop the recordings in `radio/voice/` as `01.m4a`, `02.m4a`… and `build_hour.py` can space
them through the hour between tracks. Twenty lines over a sixty-minute cycle is roughly one
every three minutes, which is about what a real station does and well short of wearing out.
