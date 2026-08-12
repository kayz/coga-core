import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateRelease, getSourceContext } from "./lib.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--output");
if (outputIndex < 0 || !args[outputIndex + 1])
  throw new Error(
    "Usage: release:generate -- --output <empty-directory> [--tag v0.2.0]",
  );
const tagIndex = args.indexOf("--tag");
if (tagIndex >= 0 && !args[tagIndex + 1])
  throw new Error("--tag requires an exact vMAJOR.MINOR.PATCH value.");
const expectedTag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
const outputDir = path.resolve(rootDir, args[outputIndex + 1]);
const source = await getSourceContext(rootDir, { expectedTag });
const result = await generateRelease(rootDir, outputDir, source);
console.log(
  JSON.stringify(
    { source, files: result.files.map((file) => path.basename(file)) },
    null,
    2,
  ),
);
