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
  "packed Core and Factory install and work from an empty consumer project",
  { timeout: 120_000 },
  async () => {
    const temporaryRoot = await mkdtemp(
      path.join(tmpdir(), "coga-package-consumer-"),
    );
    const packDir = path.join(temporaryRoot, "pack");
    const consumerDir = path.join(temporaryRoot, "consumer");
    const fixtureDir = path.join(consumerDir, "fixture");
    const coreDistDir = path.join(rootDir, "packages", "core", "dist");
    const factoryDistDir = path.join(rootDir, "packages", "factory", "dist");
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
      await mkdir(coreDistDir, { recursive: true });
      await writeFile(
        path.join(coreDistDir, "stale-consumer-probe.txt"),
        "must not enter the installed package\n",
        "utf8",
      );
      await mkdir(factoryDistDir, { recursive: true });
      await writeFile(
        path.join(factoryDistDir, "stale-consumer-probe.txt"),
        "must not enter the installed package\n",
        "utf8",
      );
      await Promise.all([
        removeWithRetry(coreDistDir),
        removeWithRetry(factoryDistDir),
      ]);
      await npm(["run", "build"], rootDir);
      const { stdout: corePackStdout } = await npm(
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
      const coreInventory = JSON.parse(corePackStdout);
      assert.equal(coreInventory.length, 1);
      assert.ok(
        !coreInventory[0].files.some(
          (file) => file.path === "dist/stale-consumer-probe.txt",
        ),
      );
      const coreTarball = path.join(packDir, coreInventory[0].filename);
      const { stdout: factoryPackStdout } = await npm(
        [
          "pack",
          "--workspace",
          "@coga/factory",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          packDir,
        ],
        rootDir,
      );
      const factoryInventory = JSON.parse(factoryPackStdout);
      assert.equal(factoryInventory.length, 1);
      assert.ok(
        !factoryInventory[0].files.some(
          (file) => file.path === "dist/stale-consumer-probe.txt",
        ),
      );
      const factoryTarball = path.join(packDir, factoryInventory[0].filename);

      await npm(
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          coreTarball,
          factoryTarball,
        ],
        consumerDir,
      );

      const esm = await run(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          [
            "import { SCHEMA_VERSION, VALIDATION_PROFILES, canTransitionLifecycle } from '@coga/core';",
            "import { FACTORY_SCHEMA_VERSION, FACTORY_STATES, FactoryController } from '@coga/factory';",
            "import { readFile } from 'node:fs/promises';",
            "import { createRequire } from 'node:module';",
            "if (SCHEMA_VERSION !== 'coga.dev/v0.2') throw new Error('wrong schema version');",
            "if (VALIDATION_PROFILES.join(',') !== 'local,public,release') throw new Error('wrong profiles');",
            "if (!canTransitionLifecycle('approved', 'published')) throw new Error('broken lifecycle API');",
            "if (FACTORY_SCHEMA_VERSION !== 'coga.dev/factory/v0.1') throw new Error('wrong factory schema version');",
            "if (!FACTORY_STATES.includes('review')) throw new Error('wrong factory states');",
            "if (typeof FactoryController !== 'function') throw new Error('missing factory controller');",
            "const schemaPath = createRequire(import.meta.url).resolve('@coga/core/schemas/coga-instance.schema.json');",
            "const schema = JSON.parse(await readFile(schemaPath, 'utf8'));",
            "if (schema.$id !== 'https://coga.dev/schemas/v0.2/coga-instance.schema.json') throw new Error('wrong schema export');",
            "if (schema.$schema !== 'https://json-schema.org/draft/2020-12/schema') throw new Error('wrong schema dialect');",
            "const factorySchemaPath = createRequire(import.meta.url).resolve('@coga/factory/schemas/work-order.schema.json');",
            "const factorySchema = JSON.parse(await readFile(factorySchemaPath, 'utf8'));",
            "if (factorySchema.$id !== 'https://coga.dev/schemas/factory/v0.1/work-order.schema.json') throw new Error('wrong factory schema export');",
            "console.log(`${SCHEMA_VERSION}|${FACTORY_SCHEMA_VERSION}`);",
          ].join("\n"),
        ],
        consumerDir,
      );
      assert.equal(esm.stdout.trim(), "coga.dev/v0.2|coga.dev/factory/v0.1");

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

      const factoryCli = await npm(
        ["exec", "--offline", "--", "coga-factory", "adapters"],
        consumerDir,
      );
      const adapters = JSON.parse(factoryCli.stdout);
      assert.equal(adapters.length, 7);
      assert.ok(adapters.some((entry) => entry.id === "github.draft-pr"));
    } finally {
      await removeWithRetry(temporaryRoot);
    }
  },
);
