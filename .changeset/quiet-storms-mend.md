---
"@scribe-sdk/cli": patch
---

Fix the native CLI crashing with a raw `EPIPE` stack trace when Ctrl+C was pressed during a running Studio session: the engine already shut Studio down gracefully on SIGINT, but the CLI had no signal handler of its own and died on the raw signal before the engine could finish, tearing the pipe out from under it. A second Ctrl+C still exits immediately. Also fixes long status values (like a lockfile-conflict message) breaking the label/value grid instead of wrapping with a hanging indent, and replaces the unstyled interactive prompts with ones matching the rest of the CLI's visual grammar.
