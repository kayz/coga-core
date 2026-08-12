import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(packageRoot, "dist");

if (dirname(dist) !== packageRoot || dist === packageRoot) {
  throw new Error("Refusing to clean an unexpected Factory build path.");
}

rmSync(dist, { recursive: true, force: true });
