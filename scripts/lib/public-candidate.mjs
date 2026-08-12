import { execFileSync } from "node:child_process";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";

const MEBIBYTE = 1024 * 1024;

export const PUBLIC_RELEASE_SCHEMA_VERSION = "coga.dev/public-release/v0.2";
export const PUBLIC_RELEASE_VERSION = "0.2.0";
export const MAX_TEXT_FILE_BYTES = 2 * MEBIBYTE;
export const MAX_BINARY_FILE_BYTES = 10 * MEBIBYTE;
export const MAX_CANDIDATE_BYTES = 50 * MEBIBYTE;

const SUPPORTED_TEXT_EXTENSIONS = [
  ".cjs",
  ".css",
  ".csv",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".svg",
  ".ts",
  ".tsv",
  ".txt",
  ".wxml",
  ".wxss",
  ".xml",
  ".yaml",
  ".yml",
];

const SUPPORTED_TEXT_FILES = [
  ".gitattributes",
  ".gitignore",
  "LICENSE",
  "packages/core/LICENSE",
];

const SUPPORTED_BINARY_EXTENSIONS = {
  ".gif": "gif",
  ".jpeg": "jpeg",
  ".jpg": "jpeg",
  ".pdf": "pdf",
  ".png": "png",
  ".webp": "webp",
};

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function comparePaths(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function decodeUtf8(buffer, label) {
  try {
    return UTF8_DECODER.decode(buffer);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function listGitPaths(root, arguments_) {
  const output = execFileSync("git", arguments_, {
    cwd: root,
    encoding: "buffer",
    maxBuffer: 64 * MEBIBYTE,
  });

  return decodeUtf8(output, "git path output")
    .split("\0")
    .filter(Boolean)
    .map(normalizePath)
    .sort(comparePaths);
}

export function enumeratePublicCandidate(root = process.cwd()) {
  return listGitPaths(root, [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
}

export function enumerateTrackedFiles(root = process.cwd()) {
  return listGitPaths(root, [
    "-c",
    "core.quotepath=false",
    "ls-files",
    "-z",
    "--cached",
  ]);
}

function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireExactNumber(value, expected, label) {
  if (value !== expected) {
    throw new Error(`${label} must be ${expected}`);
  }
}

function requireStrings(value, label) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${label} must be an array of strings`);
  }
}

function requireExactStrings(value, expected, label) {
  requireStrings(value, label);

  const actual = [...value].sort(comparePaths);
  const wanted = [...expected].sort(comparePaths);
  if (
    actual.length !== wanted.length ||
    actual.some((item, index) => item !== wanted[index])
  ) {
    throw new Error(`${label} contains unsupported entries`);
  }
}

function validateManifest(manifest) {
  requireObject(manifest, "public release manifest");
  if (manifest.schemaVersion !== PUBLIC_RELEASE_SCHEMA_VERSION) {
    throw new Error(`schemaVersion must be ${PUBLIC_RELEASE_SCHEMA_VERSION}`);
  }
  if (manifest.version !== PUBLIC_RELEASE_VERSION) {
    throw new Error(`version must be ${PUBLIC_RELEASE_VERSION}`);
  }
  requireStrings(manifest.allow, "allow");
  requireStrings(manifest.deny, "deny");

  const policy = requireObject(manifest.contentPolicy, "contentPolicy");
  requireExactNumber(
    policy.maxCandidateBytes,
    MAX_CANDIDATE_BYTES,
    "contentPolicy.maxCandidateBytes",
  );

  const text = requireObject(policy.text, "contentPolicy.text");
  requireExactNumber(
    text.maxFileBytes,
    MAX_TEXT_FILE_BYTES,
    "contentPolicy.text.maxFileBytes",
  );
  requireExactStrings(
    text.extensions,
    SUPPORTED_TEXT_EXTENSIONS,
    "contentPolicy.text.extensions",
  );
  requireExactStrings(
    text.files,
    SUPPORTED_TEXT_FILES,
    "contentPolicy.text.files",
  );

  const binary = requireObject(policy.binary, "contentPolicy.binary");
  requireExactNumber(
    binary.maxFileBytes,
    MAX_BINARY_FILE_BYTES,
    "contentPolicy.binary.maxFileBytes",
  );
  const extensions = requireObject(
    binary.extensions,
    "contentPolicy.binary.extensions",
  );
  const actualBinaryEntries = Object.entries(extensions).sort(
    ([left], [right]) => comparePaths(left, right),
  );
  const expectedBinaryEntries = Object.entries(
    SUPPORTED_BINARY_EXTENSIONS,
  ).sort(([left], [right]) => comparePaths(left, right));
  if (
    actualBinaryEntries.length !== expectedBinaryEntries.length ||
    actualBinaryEntries.some(
      ([extension, format], index) =>
        extension !== expectedBinaryEntries[index][0] ||
        format !== expectedBinaryEntries[index][1],
    )
  ) {
    throw new Error(
      "contentPolicy.binary.extensions contains unsupported entries",
    );
  }

  return manifest;
}

export function loadPublicReleaseManifest(
  root = process.cwd(),
  manifestName = "public.release.json",
) {
  const manifestPath = resolve(root, manifestName);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${manifestName}: ${error.message}`);
  }
  return validateManifest(manifest);
}

export function classifyPublicFile(path, manifest) {
  const normalized = normalizePath(path);
  const textFiles = new Set(
    manifest.contentPolicy.text.files.map(normalizePath),
  );
  if (textFiles.has(normalized)) {
    return { kind: "text" };
  }

  const extension = extname(normalized).toLowerCase();
  if (manifest.contentPolicy.text.extensions.includes(extension)) {
    return { kind: "text" };
  }

  const format = manifest.contentPolicy.binary.extensions[extension];
  if (format !== undefined) {
    return { format, kind: "binary" };
  }

  return undefined;
}

function hasPrefix(buffer, expected) {
  if (buffer.length < expected.length) return false;
  return expected.every((value, index) => buffer[index] === value);
}

function hasAsciiAt(buffer, offset, expected) {
  return (
    buffer.length >= offset + expected.length &&
    buffer.subarray(offset, offset + expected.length).toString("ascii") ===
      expected
  );
}

function hasValidSignature(format, header) {
  switch (format) {
    case "png":
      return hasPrefix(
        header,
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      );
    case "jpeg":
      return hasPrefix(header, [0xff, 0xd8, 0xff]);
    case "gif":
      return hasAsciiAt(header, 0, "GIF87a") || hasAsciiAt(header, 0, "GIF89a");
    case "webp":
      return hasAsciiAt(header, 0, "RIFF") && hasAsciiAt(header, 8, "WEBP");
    case "pdf": {
      const signature = header.subarray(0, 8).toString("ascii");
      return /^%PDF-(?:1\.[0-7]|2\.0)$/u.test(signature);
    }
    default:
      return false;
  }
}

function readHeader(path, size = 16) {
  const descriptor = openSync(path, "r");
  try {
    const header = Buffer.alloc(size);
    const bytesRead = readSync(descriptor, header, 0, size, 0);
    return header.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function candidateAbsolutePath(root, path) {
  const absolute = resolve(root, ...path.split("/"));
  const fromRoot = relative(resolve(root), absolute);
  if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    return undefined;
  }
  return absolute;
}

function issue(label, path, detail) {
  return { detail, label, path };
}

export function inspectPublicCandidate({
  entries,
  manifest,
  root = process.cwd(),
} = {}) {
  const actualManifest = manifest ?? loadPublicReleaseManifest(root);
  const actualEntries = entries ?? enumeratePublicCandidate(root);
  const files = [];
  const issues = [];
  let totalBytes = 0;

  for (const path of actualEntries) {
    if (actualManifest.deny.some((rule) => matchesPublicRule(path, rule))) {
      issues.push(issue("public.denied-path", path));
    }
    if (!actualManifest.allow.some((rule) => matchesPublicRule(path, rule))) {
      issues.push(issue("public.outside-allowlist", path));
    }

    const absolute = candidateAbsolutePath(root, path);
    if (absolute === undefined) {
      issues.push(
        issue("public.unclassified-file", path, "path escapes candidate root"),
      );
      continue;
    }

    let information;
    try {
      information = lstatSync(absolute);
    } catch {
      issues.push(
        issue(
          "public.unclassified-file",
          path,
          "candidate cannot be inspected",
        ),
      );
      continue;
    }

    totalBytes += information.size;
    if (!information.isFile()) {
      issues.push(
        issue(
          "public.unclassified-file",
          path,
          "candidate is not a regular file",
        ),
      );
      continue;
    }

    const classification = classifyPublicFile(path, actualManifest);
    if (classification === undefined) {
      issues.push(
        issue("public.unclassified-file", path, "file type is not permitted"),
      );
      continue;
    }

    const file = {
      ...classification,
      absolute,
      path,
      size: information.size,
    };
    files.push(file);

    const maxFileBytes =
      classification.kind === "text"
        ? actualManifest.contentPolicy.text.maxFileBytes
        : actualManifest.contentPolicy.binary.maxFileBytes;
    if (information.size > maxFileBytes) {
      issues.push(
        issue(
          "public.file-too-large",
          path,
          `${information.size} bytes exceeds ${maxFileBytes}`,
        ),
      );
      continue;
    }

    if (classification.kind === "text") {
      let content;
      try {
        content = readFileSync(absolute);
      } catch {
        issues.push(
          issue("public.unclassified-file", path, "candidate cannot be read"),
        );
        continue;
      }
      try {
        file.content = decodeUtf8(content, path);
      } catch (error) {
        issues.push(issue("public.invalid-utf8", path, error.message));
      }
      continue;
    }

    let header;
    try {
      header = readHeader(absolute);
    } catch {
      issues.push(
        issue("public.unclassified-file", path, "candidate cannot be read"),
      );
      continue;
    }
    if (!hasValidSignature(classification.format, header)) {
      issues.push(
        issue(
          "public.invalid-signature",
          path,
          `content does not match ${classification.format}`,
        ),
      );
    }
  }

  if (totalBytes > actualManifest.contentPolicy.maxCandidateBytes) {
    issues.push(
      issue(
        "public.candidate-too-large",
        "public candidate",
        `${totalBytes} bytes exceeds ${actualManifest.contentPolicy.maxCandidateBytes}`,
      ),
    );
  }

  return {
    entries: actualEntries,
    files,
    issues,
    totalBytes,
  };
}

export function formatPublicIssue({ detail, label, path }) {
  return `${label}: ${path}${detail === undefined ? "" : ` (${detail})`}`;
}

export function matchesPublicRule(path, rule) {
  return rule.endsWith("/") ? path.startsWith(rule) : path === rule;
}
