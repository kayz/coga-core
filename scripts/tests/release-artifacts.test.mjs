import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
  EXPECTED_REPOSITORY,
  RELEASE_LIMITS,
  compareReleaseDirectories,
  generateRelease,
  readTarEntries,
  verifyRelease,
} from "../release/lib.mjs";

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function tarEntry(name, content, { declaredSize = content.length } = {}) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(
    `${declaredSize.toString(8).padStart(11, "0")}\0`,
    124,
    12,
    "ascii",
  );
  return Buffer.concat([
    header,
    content,
    Buffer.alloc((512 - (content.length % 512)) % 512),
  ]);
}
const source = {
  repository: EXPECTED_REPOSITORY,
  commit: "b".repeat(40),
  tag: null,
};

test(
  "release payload is byte-reproducible and rejects tampering",
  { timeout: 60_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "coga-release-test-"),
    );
    const first = path.join(temporaryRoot, "first");
    const second = path.join(temporaryRoot, "second");
    const distDir = path.join(rootDir, "packages", "core", "dist");
    try {
      await Promise.all([mkdir(first), mkdir(second)]);
      await mkdir(distDir, { recursive: true });
      await writeFile(
        path.join(distDir, "stale-release-probe.txt"),
        "must never enter the package\n",
        "utf8",
      );
      const firstResult = await generateRelease(rootDir, first, source);
      const secondResult = await generateRelease(rootDir, second, source);
      assert.ok(
        firstResult.inventory.files.some((file) => file.path === "LICENSE"),
      );
      assert.ok(
        !firstResult.inventory.files.some(
          (file) => file.path === "dist/stale-release-probe.txt",
        ),
      );
      await verifyRelease(rootDir, first, source);
      await verifyRelease(rootDir, second, source);
      const comparison = await compareReleaseDirectories(first, second);
      assert.equal(comparison.files.length, 3);
      assert.match(comparison.payloadSha256, /^[0-9a-f]{64}$/u);

      const sbomFile = path.join(second, "coga-core-0.2.0.cdx.json");
      const sbom = JSON.parse(await readFile(sbomFile, "utf8"));
      sbom.metadata.properties.find(
        (property) => property.name === "coga:source:commit",
      ).value = "c".repeat(40);
      await writeFile(sbomFile, JSON.stringify(sbom, null, 2), "utf8");
      await assert.rejects(
        () => verifyRelease(rootDir, second, source),
        /Artifact (?:size|SHA-256)/u,
      );
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  },
);

test("release generation refuses every output path inside the workspace", async () => {
  const output = path.join(rootDir, "packages", "core", "dist", "release");
  await rm(output, { recursive: true, force: true });
  await assert.rejects(
    () => generateRelease(rootDir, output, source),
    /outside the Git workspace/u,
  );
  await rm(output, { recursive: true, force: true });
});

test("release verification enforces bounded inputs", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "coga-release-limits-"),
  );
  const valid = path.join(temporaryRoot, "valid");
  const oversized = path.join(temporaryRoot, "oversized");
  try {
    await Promise.all([mkdir(valid), mkdir(oversized)]);
    await generateRelease(rootDir, valid, source);
    for (const name of ["coga-core-0.2.0.tgz", "coga-core-0.2.0.cdx.json"]) {
      await copyFile(path.join(valid, name), path.join(oversized, name));
    }
    await writeFile(
      path.join(oversized, "coga-core-0.2.0.release.json"),
      Buffer.alloc(RELEASE_LIMITS.manifestBytes + 1, 0x20),
    );
    await assert.rejects(
      () => verifyRelease(rootDir, oversized, source),
      /Release manifest exceeds/u,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test("tar parser rejects duplicate, truncated, and decompression-bomb entries", () => {
  const duplicate = gzipSync(
    Buffer.concat([
      tarEntry("package/LICENSE", Buffer.from("first")),
      tarEntry("package/LICENSE", Buffer.from("second")),
      Buffer.alloc(1024),
    ]),
  );
  assert.throws(() => readTarEntries(duplicate), /Duplicate tar entry/u);

  const truncated = gzipSync(
    tarEntry("package/package.json", Buffer.from("{}"), {
      declaredSize: 2048,
    }),
  );
  assert.throws(() => readTarEntries(truncated), /archive boundary/u);

  const bomb = gzipSync(Buffer.alloc(RELEASE_LIMITS.unpackedBytes + 1));
  assert.throws(() => readTarEntries(bomb), /unpacked safety budget/u);
});
