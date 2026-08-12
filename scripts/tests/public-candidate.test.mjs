import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const TEST_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const BOUNDARY_SCRIPT = resolve(TEST_DIRECTORY, "../public-boundary-check.mjs");
const PRIVACY_SCRIPT = resolve(TEST_DIRECTORY, "../privacy-check.mjs");
const MEBIBYTE = 1024 * 1024;

function releaseManifest(overrides = {}) {
  return {
    schemaVersion: "coga.dev/public-release/v0.2",
    version: "0.2.0",
    allow: ["public.release.json", "fixtures/"],
    deny: ["private/"],
    contentPolicy: {
      maxCandidateBytes: 50 * MEBIBYTE,
      text: {
        maxFileBytes: 2 * MEBIBYTE,
        extensions: [
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
        ],
        files: [".gitattributes", ".gitignore", "LICENSE"],
      },
      binary: {
        maxFileBytes: 10 * MEBIBYTE,
        extensions: {
          ".gif": "gif",
          ".jpeg": "jpeg",
          ".jpg": "jpeg",
          ".pdf": "pdf",
          ".png": "png",
          ".webp": "webp",
        },
      },
    },
    ...overrides,
  };
}

function createRepository(t, manifest = releaseManifest()) {
  const root = mkdtempSync(join(tmpdir(), "coga-public-candidate-"));
  t.after(() => rmSync(root, { force: true, recursive: true }));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFile(
    root,
    "public.release.json",
    JSON.stringify(manifest, undefined, 2),
  );
  return root;
}

function writeFile(root, path, content) {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

function writeSparseFile(root, path, size, header) {
  const absolute = join(root, ...path.split("/"));
  mkdirSync(dirname(absolute), { recursive: true });
  const descriptor = openSync(absolute, "w");
  try {
    ftruncateSync(descriptor, size);
    writeSync(descriptor, header, 0, header.length, 0);
  } finally {
    closeSync(descriptor);
  }
}

function run(script, root) {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
  });
}

test("privacy scans CSV and SVG candidate content", (t) => {
  const root = createRepository(t);
  const privatePortal = ["yundoc", "csc", "com", "cn"].join(".");
  writeFile(root, "fixtures/private.csv", `source,${privatePortal}\n`);
  writeFile(
    root,
    "fixtures/private.svg",
    "<svg><text>DT \u641c\u7d22</text></svg>",
  );

  const result = run(PRIVACY_SCRIPT, root);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /fixtures\/private\.csv: private document portal/u,
  );
  assert.match(
    result.stderr,
    /fixtures\/private\.svg: private provider label/u,
  );
});

test("boundary accepts each supported exact binary signature", (t) => {
  const root = createRepository(t);
  writeFile(root, "fixtures/image.png", Buffer.from("89504e470d0a1a0a", "hex"));
  writeFile(root, "fixtures/photo.jpg", Buffer.from("ffd8ff", "hex"));
  writeFile(root, "fixtures/animation.gif", Buffer.from("GIF89a", "ascii"));
  writeFile(
    root,
    "fixtures/image.webp",
    Buffer.concat([
      Buffer.from("RIFF", "ascii"),
      Buffer.alloc(4),
      Buffer.from("WEBP", "ascii"),
    ]),
  );
  writeFile(root, "fixtures/document.pdf", Buffer.from("%PDF-2.0", "ascii"));

  const result = run(BOUNDARY_SCRIPT, root);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /6 candidate files/u);
});

test("boundary rejects malformed signatures for every binary type", (t) => {
  const root = createRepository(t);
  for (const path of [
    "fixtures/image.png",
    "fixtures/photo.jpeg",
    "fixtures/animation.gif",
    "fixtures/image.webp",
    "fixtures/document.pdf",
  ]) {
    writeFile(root, path, Buffer.from("not the declared format", "ascii"));
  }

  const result = run(BOUNDARY_SCRIPT, root);

  assert.equal(result.status, 1);
  for (const name of [
    "image.png",
    "photo.jpeg",
    "animation.gif",
    "image.webp",
    "document.pdf",
  ]) {
    assert.match(
      result.stderr,
      new RegExp(
        `public\\.invalid-signature: fixtures/${name.replace(".", "\\.")}`,
        "u",
      ),
    );
  }
});

test("boundary rejects a text file over 2 MiB", (t) => {
  const root = createRepository(t);
  writeSparseFile(
    root,
    "fixtures/large.txt",
    2 * MEBIBYTE + 1,
    Buffer.from("a"),
  );

  const result = run(BOUNDARY_SCRIPT, root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /public\.file-too-large: fixtures\/large\.txt/u);
});

test("boundary rejects a binary file over 10 MiB", (t) => {
  const root = createRepository(t);
  writeSparseFile(
    root,
    "fixtures/large.png",
    10 * MEBIBYTE + 1,
    Buffer.from("89504e470d0a1a0a", "hex"),
  );

  const result = run(BOUNDARY_SCRIPT, root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /public\.file-too-large: fixtures\/large\.png/u);
});

test("boundary rejects a public candidate over 50 MiB", (t) => {
  const root = createRepository(t);
  for (let index = 0; index < 5; index += 1) {
    writeSparseFile(
      root,
      `fixtures/image-${index}.png`,
      10 * MEBIBYTE,
      Buffer.from("89504e470d0a1a0a", "hex"),
    );
  }

  const result = run(BOUNDARY_SCRIPT, root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /public\.candidate-too-large: public candidate/u);
  assert.doesNotMatch(result.stderr, /public\.file-too-large/u);
});

test("boundary rejects ZIP and unknown file extensions", (t) => {
  const root = createRepository(t);
  writeFile(root, "fixtures/archive.zip", Buffer.from("504b0304", "hex"));
  writeFile(root, "fixtures/data.bin", Buffer.from("unknown", "ascii"));

  const result = run(BOUNDARY_SCRIPT, root);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /public\.unclassified-file: fixtures\/archive\.zip/u,
  );
  assert.match(
    result.stderr,
    /public\.unclassified-file: fixtures\/data\.bin/u,
  );
});

test("NUL-safe enumeration preserves a Unicode filename", (t) => {
  const root = createRepository(t);
  writeFile(
    root,
    "fixtures/\u5ba1\u8ba1 \u6587\u6863.md",
    "safe public content\n",
  );

  const boundary = run(BOUNDARY_SCRIPT, root);
  const privacy = run(PRIVACY_SCRIPT, root);

  assert.equal(boundary.status, 0, boundary.stderr);
  assert.match(boundary.stdout, /2 candidate files/u);
  assert.equal(privacy.status, 0, privacy.stderr);
  assert.match(privacy.stdout, /2 public text files scanned/u);
});

test("boundary rejects invalid UTF-8 text", (t) => {
  const root = createRepository(t);
  writeFile(root, "fixtures/invalid.txt", Buffer.from([0xc3, 0x28]));

  const result = run(BOUNDARY_SCRIPT, root);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /public\.invalid-utf8: fixtures\/invalid\.txt/u);
});

test("privacy preserves the tracked private-path check", (t) => {
  const root = createRepository(t);
  writeFile(root, "private/secret.md", "local-only\n");
  execFileSync(
    "git",
    ["-c", "core.autocrlf=false", "add", "-f", "private/secret.md"],
    { cwd: root },
  );

  const result = run(PRIVACY_SCRIPT, root);

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /private\/secret\.md: local-only path is tracked/u,
  );
});
