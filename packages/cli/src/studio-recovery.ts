import { createHash, randomBytes } from "node:crypto";
import { open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";

import { syncDirectory } from "./studio-fs.js";

export interface StudioRecoveryRecord {
  readonly schema: 1;
  readonly sourcePath: string;
  readonly baseDiskVersion: string;
  readonly draftSource: string;
  readonly revision: number;
  readonly writtenAt: string;
  readonly checksum: string;
}

interface RecoveryInput {
  readonly sourcePath: string;
  readonly baseDiskVersion: string;
  readonly draftSource: string;
  readonly revision: number;
}

export class StudioRecoveryStore {
  readonly #directory: string;
  readonly #activePath: string;
  readonly #key: string;

  constructor(sourcePath: string, root = defaultStudioStateRoot()) {
    this.#key = studioRecoveryKey(sourcePath);
    this.#directory = join(root, "recovery");
    this.#activePath = join(this.#directory, `${this.#key}.json`);
  }

  async loadDraft(): Promise<StudioRecoveryRecord | undefined> {
    let source: string;
    try {
      source = await readFile(this.#activePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    try {
      return validateRecord(JSON.parse(source));
    } catch {
      await this.#quarantineCorruptRecord();
      return undefined;
    }
  }

  async writeDraft(input: RecoveryInput): Promise<StudioRecoveryRecord> {
    const record = createRecord(input);
    await durableJsonWrite(this.#activePath, record);
    return record;
  }

  async archiveDraft(reason: "discarded" | "saved" | "reverted"): Promise<string | undefined> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const archived = join(this.#directory, `${this.#key}.${Date.now()}.${randomBytes(4).toString("hex")}.${reason}.json`);
    try {
      await rename(this.#activePath, archived);
      await syncDirectory(this.#directory);
      await this.#trimArchives();
      return archived;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeHistory(input: RecoveryInput, reason: "checkpoint"): Promise<string> {
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    const archived = join(this.#directory, `${this.#key}.${Date.now()}.${randomBytes(4).toString("hex")}.${reason}.json`);
    await durableJsonWrite(archived, createRecord(input));
    await this.#trimArchives();
    return archived;
  }

  async loadLatestArchive(reason: "discarded" | "saved" | "reverted"): Promise<StudioRecoveryRecord | undefined> {
    try {
      const suffix = `.${reason}.json`;
      const entries = (await readdir(this.#directory))
        .filter((entry) => entry.startsWith(`${this.#key}.`) && entry.endsWith(suffix))
        .sort()
        .reverse();
      for (const entry of entries) {
        try {
          return validateRecord(JSON.parse(await readFile(join(this.#directory, entry), "utf8")));
        } catch {
          continue;
        }
      }
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async removeActiveDraft(): Promise<void> {
    await unlink(this.#activePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  async #quarantineCorruptRecord(): Promise<void> {
    const quarantine = `${this.#activePath}.${Date.now()}.corrupt`;
    await rename(this.#activePath, quarantine).catch(() => undefined);
  }

  async #trimArchives(): Promise<void> {
    const archiveName = new RegExp(`^${this.#key}\\.\\d+\\.[0-9a-f]+\\.(?:discarded|saved|reverted|checkpoint)\\.json$`, "u");
    const entries = (await readdir(this.#directory))
      .filter((entry) => archiveName.test(entry))
      .sort()
      .reverse();
    await Promise.all(entries.slice(20).map((entry) => unlink(join(this.#directory, entry)).catch(() => undefined)));
  }
}

export function studioRecoveryKey(sourcePath: string): string {
  return createHash("sha256").update(sourcePath).digest("hex");
}

export function defaultStudioStateRoot(): string {
  if (process.env["SCRIBE_STUDIO_STATE_DIR"]) return process.env["SCRIBE_STUDIO_STATE_DIR"];
  if (platform() === "win32") return join(process.env["LOCALAPPDATA"] ?? homedir(), "Scribe Studio");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "Scribe Studio");
  return join(process.env["XDG_STATE_HOME"] ?? join(homedir(), ".local", "state"), "scribe-studio");
}

function createRecord(input: RecoveryInput): StudioRecoveryRecord {
  const writtenAt = new Date().toISOString();
  return {
    schema: 1,
    ...input,
    writtenAt,
    checksum: checksum(input)
  };
}

function validateRecord(value: unknown): StudioRecoveryRecord {
  if (
    typeof value !== "object"
    || value === null
    || (value as Partial<StudioRecoveryRecord>).schema !== 1
    || typeof (value as Partial<StudioRecoveryRecord>).sourcePath !== "string"
    || typeof (value as Partial<StudioRecoveryRecord>).baseDiskVersion !== "string"
    || typeof (value as Partial<StudioRecoveryRecord>).draftSource !== "string"
    || !Number.isSafeInteger((value as Partial<StudioRecoveryRecord>).revision)
    || typeof (value as Partial<StudioRecoveryRecord>).writtenAt !== "string"
    || typeof (value as Partial<StudioRecoveryRecord>).checksum !== "string"
  ) {
    throw new Error("Invalid Scribe Studio recovery record.");
  }
  const record = value as StudioRecoveryRecord;
  if (record.checksum !== checksum(record)) throw new Error("Scribe Studio recovery checksum mismatch.");
  return record;
}

function checksum(input: Pick<StudioRecoveryRecord, "sourcePath" | "baseDiskVersion" | "draftSource" | "revision">): string {
  return createHash("sha256")
    .update(input.sourcePath)
    .update("\0")
    .update(input.baseDiskVersion)
    .update("\0")
    .update(String(input.revision))
    .update("\0")
    .update(input.draftSource)
    .digest("hex");
}

async function durableJsonWrite(path: string, value: unknown): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}-${randomBytes(8).toString("hex")}.tmp`;
  let exists = false;
  try {
    const handle = await open(temporary, "wx", 0o600);
    exists = true;
    try {
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    exists = false;
    await syncDirectory(directory);
  } finally {
    if (exists) await unlink(temporary).catch(() => undefined);
  }
}
