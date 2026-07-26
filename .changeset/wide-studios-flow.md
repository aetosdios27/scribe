---
"@scribe-sdk/styles": patch
"@scribe-sdk/cli": patch
---

Keep Scribe Studio's Rich Text table controls compact without stealing space from article content. One- to three-column tables now fit the editor pane, while wider tables scroll within it and preserve GFM column alignment.

Direct `@scribe-sdk/styles` consumers that hand-author `.scribe-table-scroll` wrappers must add `data-scribe-table-layout="wide"` for column-count-based horizontal scrolling, or provide their own wide-table sizing CSS. Scribe's MDX compiler emits this attribute automatically.
