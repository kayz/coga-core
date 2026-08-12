import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSourceContext, reproducibilityCheck } from "./lib.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
if (tagIndex >= 0 && !args[tagIndex + 1])
  throw new Error("--tag requires an exact vMAJOR.MINOR.PATCH value.");
const expectedTag = tagIndex >= 0 ? args[tagIndex + 1] : undefined;
const source = await getSourceContext(rootDir, { expectedTag });
const result = await reproducibilityCheck(rootDir, source);
console.log(JSON.stringify({ reproducible: true, source, ...result }, null, 2));
