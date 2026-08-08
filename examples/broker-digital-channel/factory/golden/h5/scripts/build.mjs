import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "application-lock.json",
  "src/index.html",
  "src/app.mjs",
  "src/state.mjs",
];

for (const file of required) {
  if (!existsSync(resolve(root, file)))
    throw new Error(`Missing build input: ${file}`);
}

const lock = JSON.parse(
  readFileSync(resolve(root, "application-lock.json"), "utf8"),
);
const html = readFileSync(resolve(root, "src/index.html"), "utf8");
if (lock.spec.deliveryTarget !== "web-h5")
  throw new Error("Wrong delivery target");
if (!html.includes('src="./app.mjs"'))
  throw new Error("H5 entry module is missing");

const digest = createHash("sha256")
  .update(required.map((file) => readFileSync(resolve(root, file))).join("\n"))
  .digest("hex");
process.stdout.write(`h5 build ${digest}\n`);
