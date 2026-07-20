---
"@scribe-sdk/cli": patch
---

Keep constrained Rich Text mode source-safe by avoiding serialization when users switch modes without editing, preserving protected MDX islands byte-for-byte, and naming the exact JSX, frontmatter, import, export, expression, comment, directive, or code metadata construct when an unsafe edit is rejected.
