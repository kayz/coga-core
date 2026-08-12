import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSourceContext, verifyRelease } from "./lib.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const args = process.argv.slice(2);
const directoryIndex = args.indexOf("--directory");
if (directoryIndex < 0 || !args[directoryIndex + 1])
  throw new Error(
    "Usage: release:verify -- --directory <release-directory> [--tag v0.2.0]",
  );
const tagIndex = args.indexOf("--tag");
if (tagIndex >= 0 && !args[tagIndex + 1])
  throw new Error("--tag requires an exact vMAJOR.MINOR.PATCH value.");
const expectedTag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
const source = await getSourceContext(rootDir, { expectedTag });
await verifyRelease(
  rootDir,
  path.resolve(rootDir, args[directoryIndex + 1]),
  source,
);
console.log(JSON.stringify({ verified: true, source }, null, 2));
