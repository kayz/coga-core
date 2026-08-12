import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const applicationRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = resolve(applicationRoot, "src");
const outputRoot = process.env.COGA_BUILD_OUTPUT
  ? resolve(process.env.COGA_BUILD_OUTPUT)
  : resolve(applicationRoot, "dist");

mkdirSync(outputRoot, { recursive: true });
for (const name of readdirSync(sourceRoot).sort()) {
  const source = resolve(sourceRoot, name);
  if (!statSync(source).isFile())
    throw new Error(`Unexpected non-file source: ${name}`);
  cpSync(source, resolve(outputRoot, name), { errorOnExist: true });
}
