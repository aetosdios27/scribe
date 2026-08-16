---
"@scribe-sdk/cli": patch
---

Start Scribe Studio with the default loopback port when none is provided, so `scribe studio init` and `scribe studio <article>` launch without requiring `--port`; omit or null ports are treated as the default instead of an error.