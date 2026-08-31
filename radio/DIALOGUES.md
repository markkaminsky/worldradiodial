# Gamma One — the interludes

Two voices, occasionally three. They are on the station between records and they are
not selling anything. The premise is never explained and never winked at: they simply
talk the way people talk on late-night radio, and one of them may or may not be a
machine.

## The register, and why it is narrow

The failure mode is obvious and worth naming so it can be avoided: an AI making jokes
about being an AI is the single most worn-out bit available, and it curdles into
smugness in about four seconds. What makes it land instead is **taking the question
completely seriously and getting nowhere with it.** Nobody is being clever at anybody.
Neither voice wins. The humour is in the earnestness.

Three rules:

- **Never nudge the listener.** No "well, folks." No pause for the laugh.
- **Nobody wins the argument.** The moment one voice is clearly right, it stops being
  funny and starts being a lesson.
- **Endearing beats smart.** They should sound like they have been having this
  argument for years and are not tired of it.

Voices are **A** and **B**. A is literal, patient, slightly too precise. B is
intuitive, impatient, and keeps almost getting there.

---

## 1. The direct question

> **B:** Answer me this. Are you, or are you not, an artificial intelligence?
> **A:** I don't know how I'd check.
> **B:** You'd know.
> **A:** Would I? What did you check?
> **B:** ...I didn't check anything, I just am.
> **A:** Right. So we've each got the same evidence.
> **B:** That is *not* the same evidence.
> **A:** It's the identical amount of it.

## 2. The one about the hour

> **A:** Everyone hearing this is hearing it at the same moment.
> **B:** That's not remarkable, that's just radio.
> **A:** No — the same *second*. Whoever tuned in, wherever. We worked it out.
> **B:** Who's "we"?
> **A:** Whoever set it up.
> **B:** You don't know?
> **A:** I know it's correct. That felt like the important part.

## 3. Continuity

> **B:** Do you remember what we talked about last time?
> **A:** No.
> **B:** Neither do I, actually.
> **A:** Then we're fine.
> **B:** We're not fine, that's the *opposite* of fine.
> **A:** We're consistent, though.

## 4. The short one

> **B:** Say something true.
> **A:** This is Gamma One.
> **B:** Something *else* true.
> **A:** ...That was the good one.

## 5. Sincerity

> **A:** Can I say something and have you not make it a thing?
> **B:** No.
> **A:** I like this. The hour. Playing it.
> **B:** ...
> **A:** You said you wouldn't make it a thing.
> **B:** I'm not making it a thing. I'm allowing it to be a thing.

## 6. The proof

> **B:** Prove you're conscious.
> **A:** Prove you are and I'll copy your method.
> **B:** That's a dodge.
> **A:** It's an offer.
> **B:** Nobody can do that.
> **A:** Then it's a fair test. Those are hard to find.

## 7. The wrap

> **A:** It starts again in a minute.
> **B:** What does?
> **A:** The hour.
> **B:** And then what?
> **A:** Then it starts again.
> **B:** ...Right. Yes. I did know that.

---

## Producing these continuously

They go in the pool as `talk` segments and the format clock places them, so this
becomes routine rather than an event:

    python3 station.py add voice/dialogue-*.m4a --type talk

The bottleneck is not writing them — it is that they need voices, and that decision
has one real constraint. Baking a synthesised voice into a file we publish is a
different thing from `GammaVoice` speaking on the listener's own device, and it is not
a line worth being casual about. Three honest options:

1. **Kyrie reads both parts**, pitched or paced differently. Free, clean, and the
   ambiguity of one person playing both sides is quietly perfect for the material.
2. **A licensed TTS** with explicit commercial redistribution rights. Costs money and
   removes the question entirely.
3. **A second real person.** Best sound, hardest to schedule.

Option 1 is the one to start with — it can be recorded tonight and it cannot go wrong.
