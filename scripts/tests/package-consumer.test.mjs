import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

async function run(command, args, cwd) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message]
      .filter(Boolean)
      .join("\n");
    throw new Error(`${command} ${args.join(" ")} failed:\n${detail}`, {
      cause: error,
    });
  }
}

async function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli)
    throw new Error("package:consumer-test must run through an npm script.");
  return run(process.execPath, [npmCli, ...args], cwd);
}

async function removeWithRetry(directory) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 4 ||
        !["EBUSY", "EPERM", "ENOTEMPTY"].includes(error.code)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
    }
  }
}

test(
  "packed Core installs and works from an empty consumer project",
  { timeout: 120_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "coga-package-consumer-"),
    );
    const packDir = path.join(temporaryRoot, "pack");
    const consumerDir = path.join(temporaryRoot, "consumer");
    const fixtureDir = path.join(consumerDir, "fixture");
    const distDir = path.join(rootDir, "packages", "core", "dist");
    try {
      await Promise.all([
        mkdir(packDir),
        mkdir(consumerDir),
        cp(
          path.join(rootDir, "packages", "core", "tests", "fixtures", "valid"),
          fixtureDir,
          { recursive: true },
        ),
      ]);
      await mkdir(distDir, { recursive: true });
      await writeFile(
        path.join(distDir, "stale-consumer-probe.txt"),
        "must not enter the installed package\n",
        "utf8",
      );
      await removeWithRetry(distDir);
      await npm(["run", "build", "--workspace", "@coga/core"], rootDir);
      const { stdout } = await npm(
        [
          "pack",
          "--workspace",
          "@coga/core",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          packDir,
        ],
        rootDir,
      );
      const inventory = JSON.parse(stdout);
      assert.equal(inventory.length, 1);
      assert.ok(
        !inventory[0].files.some(
          (file) => file.path === "dist/stale-consumer-probe.txt",
        ),
      );
      const tarball = path.join(packDir, inventory[0].filename);

      await npm(
        ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball],
        consumerDir,
      );

      const esm = await run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            "import { SCHEMA_VERSION, VALIDATION_PROFILES, canTransitionLifecycle } from '@coga/core';",
            "import { readFile } from 'node:fs/promises';",
            "import { createRequire } from 'node:module';",
            "if (SCHEMA_VERSION !== 'coga.dev/v0.2') throw new Error('wrong schema version');",
            "if (VALIDATION_PROFILES.join(',') !== 'local,public,release') throw new Error('wrong profiles');",
            "if (!canTransitionLifecycle('approved', 'published')) throw new Error('broken lifecycle API');",
            "const schemaPath = createRequire(import.meta.url).resolve('@coga/core/schemas/coga-instance.schema.json');",
            "const schema = JSON.parse(await readFile(schemaPath, 'utf8'));",
            "if (schema.$id !== 'https://coga.dev/schemas/v0.2/coga-instance.schema.json') throw new Error('wrong schema export');",
            "if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('wrong schema dialect');",
            "console.log(SCHEMA_VERSION);",
          ].join("\n"),
        ],
        consumerDir,
      );
      assert.equal(esm.stdout.trim(), "coga.dev/v0.2");

      const cli = await npm(
        [
          "exec",
          "--offline",
          "--",
          "coga",
          "validate",
          path.join(fixtureDir, "instance.yaml"),
          "--profile",
          "release",
        ],
        consumerDir,
      );
      assert.match(
        cli.stdout,
        /Valid COGA instance: example\.broker-channel\.instance/u,
      );
    } finally {
      await removeWithRetry(temporaryRoot);
    }
  },
);
