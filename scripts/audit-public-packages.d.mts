export const publicPackages: readonly ["styles", "react", "mdx", "cli"];

export function auditPublicPackages(): Promise<void>;

export function decodeAuditResponse(bytes: Uint8Array): Record<string, Array<{
  readonly id: number;
  readonly severity?: string;
  readonly title?: string;
  readonly url?: string;
}>>;
