---
"@scribe-sdk/cli": patch
---

Prevent Scribe Studio from overwriting source changed by an external editor by revalidating the file immediately before save. Preserve unsaved drafts when the source is deleted or renamed, reload explicitly from current disk content, and retain the article's LF or CRLF line endings.
