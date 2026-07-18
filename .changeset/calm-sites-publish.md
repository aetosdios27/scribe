---
"@scribe-sdk/react": minor
"@scribe-sdk/styles": minor
"@scribe-sdk/mdx": minor
"@scribe-sdk/cli": minor
---

Make Scribe's public alpha safe for established React sites: add foundation, default, and Tailwind style modes that preserve host-owned typography; add explicit, idempotent `scb init`; add a dedicated `next-mdx-remote/rsc` adapter; add the local source-authoritative Scribe Studio; and strengthen computed-style and visual-continuity verification.

Existing `default.css` imports remain supported. Established sites should use `foundation.css`, Tailwind Typography sites should use `tailwind.css`, and `next-mdx-remote/rsc` integrations should use `createScribeRemoteMdxOptions()` from `@scribe-sdk/mdx/next-remote`.
