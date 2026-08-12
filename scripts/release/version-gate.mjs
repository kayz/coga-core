import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSourceContext } from "./lib.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const args = process.argv.slice(2);
const tagIndex = args.indexOf("--tag");
const commitIndex = args.indexOf("--commit");
if (
  tagIndex < 0 ||
  commitIndex < 0 ||
  !args[tagIndex + 1] ||
  !args[commitIndex + 1]
) {
  throw new Error("Usage: version-gate.mjs --tag v0.2.0 --commit <full-sha>");
}
const source = await getSourceContext(rootDir, {
  expectedTag: args[tagIndex + 1],
  expectedCommit: args[commitIndex + 1],
});
console.log(JSON.stringify({ gated: true, source }, null, 2));
