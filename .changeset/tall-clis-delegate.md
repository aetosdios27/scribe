---
"@scribe-sdk/cli": minor
---

Add a user-level `scribe` launcher that delegates to the project-local CLI inside a supported project and runs directly elsewhere, print the project's Scribe state from a bare `scribe` invocation, and make `scribe integrate` own package installation as a reviewed transaction that snapshots and restores the manifest, lockfile, and source files on failure and verifies the packages that should be present at the running CLI's version, the selected stylesheet, and the reported files. For pnpm and yarn the plan reports copyable install commands and stops with exit `2` before changing files until those packages are installed, and mismatched installed Scribe versions report the exact aligned `update` commands.
