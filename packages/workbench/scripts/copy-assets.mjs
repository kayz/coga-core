import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const target = resolve("dist/public");
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(resolve("public"), target, { recursive: true });
