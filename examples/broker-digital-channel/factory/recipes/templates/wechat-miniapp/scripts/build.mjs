import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const required = [
  "application-lock.json",
  "src/app.js",
  "src/app.json",
  "src/domain/access.js",
  "src/pages/home/index.js",
];

for (const file of required) {
  if (!existsSync(resolve(root, file)))
    throw new Error(`Missing build input: ${file}`);
}

const lock = JSON.parse(
  readFileSync(resolve(root, "application-lock.json"), "utf8"),
);
const app = JSON.parse(readFileSync(resolve(root, "src/app.json"), "utf8"));
if (lock.spec.deliveryTarget !== "wechat-miniapp")
  throw new Error("Wrong delivery target");
if (!app.pages.includes("pages/home/index"))
  throw new Error("Home page is not registered");

const digest = createHash("sha256")
  .update(required.map((file) => readFileSync(resolve(root, file))).join("\n"))
  .digest("hex");
process.stdout.write(`miniapp build ${digest}\n`);
