---
"@scribe-sdk/styles": patch
---

Fix the code frame's line-wrap toggle button rendering as an unstyled black glyph in `default.css` and `foundation.css`. `WrapToggleButton`'s icon had no base rule, so its `<svg>` fell back to the browser's default `fill: black` instead of the outlined stroke icon used everywhere else in the code frame.
