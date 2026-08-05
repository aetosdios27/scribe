---
"@scribe-sdk/cli": minor
---

Add a user-level `scribe` launcher that delegates to the project-local CLI inside a supported project and runs directly elsewhere, print the project's Scribe state from a bare `scribe` invocation, and make `scribe integrate` own package installation as a reviewed transaction that snapshots and restores the manifest, lockfile, and source files on failure and verifies installed package versions, the selected stylesheet, and the reported files. pnpm and yarn installations defer to a precise manual step, and mismatched installed Scribe versions report the exact aligned `update` command.
