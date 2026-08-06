export interface PublicPackage {
  readonly name: "@scribe-sdk/styles" | "@scribe-sdk/react" | "@scribe-sdk/mdx" | "@scribe-sdk/cli";
  readonly directory: "styles" | "react" | "mdx" | "cli";
}

export interface PackageRegistry {
  versions(name: PublicPackage["name"]): Promise<string[]>;
  distTags(name: PublicPackage["name"]): Promise<Record<string, string | undefined>>;
  publishTarball(name: PublicPackage["name"], tarball: string, tag: "alpha"): Promise<void>;
  setDistTag(name: PublicPackage["name"], version: string, tag: "latest"): Promise<void>;
}

export const publicPackages: readonly PublicPackage[];

export function isDirectExecution(moduleUrl: string, entryPath: string | undefined, cwd?: string): boolean;

export function publishAlphaPackages(options?: {
  root?: string;
  registry?: PackageRegistry;
  distTagAttempts?: number;
  distTagDelayMs?: number;
}): Promise<void>;
