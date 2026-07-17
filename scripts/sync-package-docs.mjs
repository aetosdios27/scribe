import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageDirectories = ["mdx", "react", "styles", "cli"];
const canonicalFiles = ["README.md", "SKILL.md", "LICENSE"];
const check = process.argv.includes("--check");

for (const filename of canonicalFiles) {
  const canonical = await readFile(join(root, filename), "utf8");
  for (const directory of packageDirectories) {
    const destination = join(root, "packages", directory, filename);
    if (check) {
      let packaged;
      try {
        packaged = await readFile(destination, "utf8");
      } catch {
        throw new Error(`${destination} is missing. Run \`bun run docs:sync\`.`);
      }
      if (packaged !== canonical) {
        throw new Error(`${destination} differs from ${join(root, filename)}. Run \`bun run docs:sync\`.`);
      }
    } else {
      await writeFile(destination, canonical);
    }
  }
}

process.stdout.write(`${check ? "Verified" : "Synchronized"} package README.md, SKILL.md, and LICENSE files.\n`);
