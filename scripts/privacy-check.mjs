import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const root = process.cwd();
const ignoredRoots = new Set([
  ".git",
  "node_modules",
  "dist",
  "coverage",
  "private",
  ".local",
]);
const textExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".txt",
  ".wxml",
  ".wxss",
  ".yaml",
  ".yml",
]);

const forbidden = [
  { label: "private product name", pattern: /\u4fe1\u8c1b\u542c/iu },
  {
    label: "private client application name",
    pattern: /\u873b\u8713\u70b9\u91d1/iu,
  },
  {
    label: "private source path",
    pattern: /(?:C:\\\\|C:\/)(?:OneDrive|WorkBuddy)/iu,
  },
  { label: "private document portal", pattern: /yundoc\.csc\.com\.cn/iu },
  { label: "private source image", pattern: /image-2026080[67]/iu },
  {
    label: "private provider label",
    pattern: /DT\s*\u641c\u7d22|\u4e1c\u8d22\u63a5\u53e3/iu,
  },
];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (ignoredRoots.has(entry)) continue;
    const absolute = join(directory, entry);
    const info = statSync(absolute);
    if (info.isDirectory()) files.push(...walk(absolute));
    else if (textExtensions.has(extname(entry).toLowerCase()))
      files.push(absolute);
  }
  return files;
}

const violations = [];
for (const file of walk(root)) {
  const content = readFileSync(file, "utf8");
  for (const rule of forbidden) {
    if (rule.pattern.test(content)) {
      violations.push(`${relative(root, file)}: ${rule.label}`);
    }
  }
}

let tracked = [];
try {
  tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
    .split(/\r?\n/u)
    .filter(Boolean);
} catch {
  // A pre-commit workspace may have no tracked files yet; content scanning still runs.
}

for (const file of tracked) {
  if (file === "private" || file.startsWith("private/")) {
    violations.push(`${file}: local-only path is tracked`);
  }
}

if (violations.length > 0) {
  console.error(
    "Public-boundary violations detected:\n" +
      violations.map((item) => `- ${item}`).join("\n"),
  );
  process.exit(1);
}

console.log(
  `Privacy check passed (${walk(root).length} public text files scanned).`,
);
