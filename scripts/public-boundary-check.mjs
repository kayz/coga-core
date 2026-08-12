import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("public.release.json", "utf8"));
const normalize = (value) => value.replaceAll("\\", "/");
const entries = execFileSync(
  "git",
  [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ],
  { encoding: "utf8" },
)
  .split("\0")
  .filter(Boolean)
  .map(normalize);

function matchesPrefix(path, rule) {
  return rule.endsWith("/") ? path.startsWith(rule) : path === rule;
}

const denied = entries.filter((path) =>
  manifest.deny.some((rule) => matchesPrefix(path, rule)),
);
const outside = entries.filter(
  (path) => !manifest.allow.some((rule) => matchesPrefix(path, rule)),
);

if (denied.length > 0 || outside.length > 0) {
  if (denied.length > 0) {
    console.error(
      "Denied paths found in the public candidate:\n" + denied.join("\n"),
    );
  }
  if (outside.length > 0) {
    console.error("Paths outside the public allowlist:\n" + outside.join("\n"));
  }
  process.exit(1);
}

console.log(
  `Public boundary passed (${entries.length} candidate files are allowlisted).`,
);
