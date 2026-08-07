import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const root = process.cwd();
const ignored = new Set([
  ".git",
  ".local",
  "coverage",
  "dist",
  "node_modules",
  "private",
]);

function markdownFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory)) {
    if (ignored.has(entry)) continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory())
      files.push(...markdownFiles(absolute));
    else if (extname(entry).toLowerCase() === ".md") files.push(absolute);
  }
  return files;
}

const violations = [];
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;
const files = markdownFiles(root);
for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    let target = match[1]?.trim() ?? "";
    if (
      target.length === 0 ||
      target.startsWith("#") ||
      /^(?:https?:|mailto:)/iu.test(target)
    ) {
      continue;
    }
    if (target.startsWith("<") && target.endsWith(">")) {
      target = target.slice(1, -1);
    }
    target = decodeURIComponent(target.split("#", 1)[0] ?? "");
    const absolute = resolve(dirname(file), target);
    if (!existsSync(absolute)) {
      violations.push(`${relative(root, file)} -> ${target}`);
    }
  }
}

if (violations.length > 0) {
  console.error(
    `Broken local Markdown links:\n${violations.map((item) => `- ${item}`).join("\n")}`,
  );
  process.exit(1);
}

console.log(
  `Documentation links passed (${files.length} Markdown files checked).`,
);
