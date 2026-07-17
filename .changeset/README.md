# Scribe Changesets

Add one Changeset for each meaningful consumer-facing change:

```bash
bunx changeset
```

Select every affected public package, choose the semver intent described in `RELEASING.md`, and write a concise present-tense summary.

A good summary:

- describes observable user impact;
- names the important capability or compatibility change;
- is understandable without reading the diff;
- states breaking behavior and required migration steps directly;
- avoids internal ticket language, implementation trivia, exaggeration, and phrases such as “misc fixes.”

Good: “Add compile-time code highlighting with filename labels, line numbers, focused lines, diffs, and plaintext fallback for unsupported languages.”

Bad: “Refactor highlighter pipeline.”

Good: “Reject unknown Callout variants during validation with an actionable diagnostic.”

Bad: “Fix validation.”

Internal refactors, tests, spelling fixes, and repository-only work do not require a package bump unless they change consumer behavior. The four public Scribe packages form one fixed version group; private integration fixtures are not released.
