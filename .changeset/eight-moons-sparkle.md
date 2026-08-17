---
"@scribe-sdk/cli": patch
---

Fix `scribe studio init`'s boxed forms rendering with overlapping, stacked borders when moving from the title form into the slug/path form and on into the plan review — the form never parked the terminal cursor below its own box before finishing, so whatever rendered next started from a cursor position still inside the previous box instead of a clean line beneath it.
