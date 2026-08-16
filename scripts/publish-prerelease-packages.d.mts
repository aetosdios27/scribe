export type NativePackageDirectory =
  | "linux-x64-gnu"
  | "linux-x64-musl"
  | "linux-arm64-gnu"
  | "linux-arm64-musl"
  | "darwin-x64"
  | "darwin-arm64"
  | "win32-x64-msvc"
  | "win32-arm64-msvc";

export interface PublicPackage {
  readonly name:
    | "@scribe-sdk/styles"
    | "@scribe-sdk/react"
    | "@scribe-sdk/mdx"
    | "@scribe-sdk/cli"
    | `@scribe-sdk/cli-${NativePackageDirectory}`;
  readonly directory: "styles" | "react" | "mdx" | "cli" | NativePackageDirectory;
}

export interface NativePackage {
  readonly name: `@scribe-sdk/cli-${NativePackageDirectory}`;
  readonly directory: NativePackageDirectory;
}

export interface PackageRegistry {
  versions(name: PublicPackage["name"]): Promise<string[]>;
  distTags(name: PublicPackage["name"]): Promise<Record<string, string | undefined>>;
  publishTarball(name: PublicPackage["name"], tarball: string, tag: "alpha" | "beta"): Promise<void>;
  setDistTag(name: PublicPackage["name"], version: string, tag: string): Promise<void>;
}

export const nativePackages: readonly NativePackage[];
export const publicPackages: readonly PublicPackage[];

export function isDirectExecution(moduleUrl: string, entryPath: string | undefined, cwd?: string): boolean;

export function publishPrereleasePackages(options?: {
  root?: string;
  registry?: PackageRegistry;
  distTagAttempts?: number;
  distTagDelayMs?: number;
}): Promise<void>;
