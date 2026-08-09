# Security

## Reporting a vulnerability

Do not open a public issue for an exploitable vulnerability.

GitHub private vulnerability reporting is not currently enabled for this repository. Send a private report to [aetosdios27@gmail.com](mailto:aetosdios27@gmail.com) with the subject `Scribe security report`. Include the affected package and version, impact, reproduction, and any suggested mitigation you already have. Please avoid sending secrets or private source beyond what is needed to reproduce the issue.

There is no guaranteed response SLA. Reports will be handled as maintainer capacity allows, with priority based on reproducibility and impact.

## Current trust model

Scribe compiles Markdown and MDX from trusted local project content. MDX is executable source: it may contain imports, exports, JSX, and expressions. Scribe does not sandbox it, and Studio's loopback server does not make untrusted MDX safe to open or compile.

Studio binds to loopback, uses a per-session mutation capability, checks origin/host context, confines selected source and host CSS paths to the workspace, rejects unsafe Rich Text rewrites, detects external file conflicts, and uses verified durable writes. These are local safety boundaries, not a multi-tenant or untrusted-content security model.

Security-sensitive issues include, when unintended:

- arbitrary execution beyond the documented trusted-MDX model;
- filesystem access or writes outside the selected workspace;
- source corruption or bypass of Studio preservation/conflict guards;
- access to the local Studio across its intended loopback, origin, host, or session boundary;
- unsafe handling represented as suitable for untrusted content; and
- package or release supply-chain compromise.

Ordinary validation errors, expected execution of trusted MDX, and styling defects can be reported with the public bug form unless they cross one of these boundaries.
