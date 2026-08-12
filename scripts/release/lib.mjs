import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const execFileAsync = promisify(execFile);
export const RELEASE_SCHEMA = "coga.dev/release-manifest/v1";
export const EXPECTED_REPOSITORY = "https://github.com/kayz/coga-core";
export const RELEASE_NODE_VERSION = "24.18.0";
export const RELEASE_NPM_VERSION = "11.16.0";
export const RELEASE_LIMITS = Object.freeze({
  manifestBytes: 64 * 1024,
  sbomBytes: 2 * 1024 * 1024,
  packageBytes: 10 * 1024 * 1024,
  unpackedBytes: 32 * 1024 * 1024,
  tarEntries: 1_000,
  jsonDepth: 64,
  jsonNodes: 100_000,
});

function isPathInside(parent, candidate) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export async function assertExternalReleaseDirectory(rootDir, outputDir) {
  const [resolvedRoot, resolvedOutput] = await Promise.all([
    realpath(rootDir),
    realpath(outputDir),
  ]);
  if (
    resolvedOutput === resolvedRoot ||
    isPathInside(resolvedRoot, resolvedOutput)
  ) {
    throw new Error(
      "Release output directory must be outside the Git workspace.",
    );
  }
  return resolvedOutput;
}

async function readFileBounded(file, limit, label) {
  const info = await stat(file);
  if (!info.isFile()) throw new Error(`${label} must be a regular file.`);
  if (info.size > limit) {
    throw new Error(`${label} exceeds the ${limit}-byte safety budget.`);
  }
  const content = await readFile(file);
  if (content.length > limit) {
    throw new Error(`${label} exceeds the ${limit}-byte safety budget.`);
  }
  return content;
}

async function readJsonBounded(file, limit, label) {
  const content = await readFileBounded(file, limit, label);
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON.`, { cause: error });
  }
  const stack = [{ value, depth: 0 }];
  let nodes = 0;
  while (stack.length) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > RELEASE_LIMITS.jsonNodes) {
      throw new Error(
        `${label} exceeds the ${RELEASE_LIMITS.jsonNodes}-node safety budget.`,
      );
    }
    if (current.depth > RELEASE_LIMITS.jsonDepth) {
      throw new Error(
        `${label} exceeds the depth-${RELEASE_LIMITS.jsonDepth} safety budget.`,
      );
    }
    if (current.value && typeof current.value === "object") {
      for (const child of Object.values(current.value)) {
        stack.push({ value: child, depth: current.depth + 1 });
      }
    }
  }
  return value;
}

async function run(command, args, cwd, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
      ...options,
    });
  } catch (error) {
    const detail = [error.stderr, error.stdout, error.message]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`, {
      cause: error,
    });
  }
}

async function runNpm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli)
    throw new Error(
      "Release tooling must be invoked through an npm script so the exact npm CLI is known.",
    );
  return run(process.execPath, [npmCli, ...args], cwd);
}

async function assertReleaseToolchain(rootDir) {
  if (process.versions.node !== RELEASE_NODE_VERSION) {
    throw new Error(
      `Release tooling requires Node.js ${RELEASE_NODE_VERSION}, got ${process.versions.node}.`,
    );
  }
  const { stdout } = await runNpm(["--version"], rootDir);
  if (stdout.trim() !== RELEASE_NPM_VERSION) {
    throw new Error(
      `Release tooling requires npm ${RELEASE_NPM_VERSION}, got ${stdout.trim()}.`,
    );
  }
}

export function canonicalize(value) {
  const compareText = (left, right) =>
    left === right ? 0 : left < right ? -1 : 1;
  if (Array.isArray(value)) {
    return value
      .map(canonicalize)
      .sort((left, right) =>
        compareText(JSON.stringify(left), JSON.stringify(right)),
      );
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return `${JSON.stringify(canonicalize(value), null, 2)}\n`;
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

export function normalizeRepositoryUrl(value) {
  const text = typeof value === "string" ? value : value?.url;
  if (!text) throw new Error("A repository URL is required.");
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/u.exec(text);
  const normalized = ssh ? `https://github.com/${ssh[1]}/${ssh[2]}` : text;
  return normalized
    .replace(/^git\+/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "");
}

export function validateReleaseTag(tag, version) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(tag)) {
    throw new Error(
      `Release tag ${tag} is not an exact vMAJOR.MINOR.PATCH tag.`,
    );
  }
  if (tag !== `v${version}`) {
    throw new Error(
      `Release tag ${tag} does not match package version ${version}.`,
    );
  }
}

export async function readPackageState(rootDir) {
  const packageFile = path.join(rootDir, "packages", "core", "package.json");
  const lockFile = path.join(rootDir, "package-lock.json");
  const [packageText, lockText] = await Promise.all([
    readFile(packageFile, "utf8"),
    readFile(lockFile, "utf8"),
  ]);
  const packageJson = JSON.parse(packageText);
  const lock = JSON.parse(lockText);
  const lockedPackage = lock.packages?.["packages/core"];
  if (
    !lockedPackage ||
    lockedPackage.name !== packageJson.name ||
    lockedPackage.version !== packageJson.version
  ) {
    throw new Error(
      "packages/core/package.json and package-lock.json are not version-aligned.",
    );
  }
  if (packageJson.name !== "@coga/core" || packageJson.version !== "0.2.0") {
    throw new Error(
      `This release line only accepts @coga/core@0.2.0, got ${packageJson.name}@${packageJson.version}.`,
    );
  }
  if (packageJson.license !== "Apache-2.0")
    throw new Error("@coga/core must declare Apache-2.0.");
  if (normalizeRepositoryUrl(packageJson.repository) !== EXPECTED_REPOSITORY) {
    throw new Error(
      "@coga/core repository metadata does not match the release repository.",
    );
  }
  return { packageJson, lock };
}

export async function getSourceContext(
  rootDir,
  {
    expectedCommit,
    expectedTag,
    requireClean = true,
    requireSignedTag = false,
  } = {},
) {
  const { stdout: rootOutput } = await run(
    "git",
    ["rev-parse", "--show-toplevel"],
    rootDir,
  );
  if (path.resolve(rootOutput.trim()) !== path.resolve(rootDir))
    throw new Error("Release command is not at the Git root.");
  const { stdout: commitOutput } = await run(
    "git",
    ["rev-parse", "HEAD"],
    rootDir,
  );
  const commit = commitOutput.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(commit))
    throw new Error("Git did not return a full SHA-1 commit identity.");
  if (expectedCommit && commit !== expectedCommit.toLowerCase()) {
    throw new Error(
      `HEAD ${commit} does not match expected commit ${expectedCommit}.`,
    );
  }
  const { stdout: remoteOutput } = await run(
    "git",
    ["remote", "get-url", "origin"],
    rootDir,
  );
  const repository = normalizeRepositoryUrl(remoteOutput.trim());
  if (repository !== EXPECTED_REPOSITORY)
    throw new Error(`Unexpected origin repository ${repository}.`);
  if (requireClean) {
    const { stdout: statusOutput } = await run(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all"],
      rootDir,
    );
    if (statusOutput.trim())
      throw new Error("Release generation requires a clean Git worktree.");
  }
  let tag = null;
  if (expectedTag) {
    const { packageJson } = await readPackageState(rootDir);
    validateReleaseTag(expectedTag, packageJson.version);
    const { stdout: tagOutput } = await run(
      "git",
      ["rev-parse", `refs/tags/${expectedTag}^{commit}`],
      rootDir,
    );
    if (tagOutput.trim().toLowerCase() !== commit)
      throw new Error(`Tag ${expectedTag} does not identify HEAD.`);
    if (requireSignedTag)
      await run("git", ["verify-tag", expectedTag], rootDir);
    tag = expectedTag;
  }
  return { repository, commit, tag };
}

function packageNameFromLockKey(key) {
  const marker = "node_modules/";
  const index = key.lastIndexOf(marker);
  if (index < 0)
    throw new Error(`Cannot derive a package name from lock key ${key}.`);
  const remainder = key.slice(index + marker.length);
  const segments = remainder.split("/");
  return segments[0].startsWith("@")
    ? `${segments[0]}/${segments[1]}`
    : segments[0];
}

function resolveLockDependency(packages, parentKey, name) {
  let base = parentKey;
  while (base) {
    const candidate = `${base}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const index = base.lastIndexOf("/node_modules/");
    base = index >= 0 ? base.slice(0, index) : "";
  }
  const rootCandidate = `node_modules/${name}`;
  return packages[rootCandidate] ? rootCandidate : null;
}

export function buildProductionGraph(packageJson, lock) {
  const packages = lock.packages;
  if (!packages || typeof packages !== "object")
    throw new Error("A package-lock v3 packages map is required.");
  const rootRef = `${packageJson.name}@${packageJson.version}`;
  const graph = new Map([[rootRef, new Set()]]);
  const queue = [];

  const addDependency = (parentRef, parentKey, name, optional) => {
    const key = resolveLockDependency(packages, parentKey, name);
    if (!key) {
      if (optional) return;
      throw new Error(
        `Production dependency ${name} from ${parentKey} is absent from package-lock.json.`,
      );
    }
    const entry = packages[key];
    const ref = `${packageNameFromLockKey(key)}@${entry.version}`;
    graph.get(parentRef).add(ref);
    queue.push({ key, ref });
  };

  for (const name of Object.keys(packageJson.dependencies ?? {}).sort()) {
    addDependency(rootRef, "packages/core", name, false);
  }
  const visitedKeys = new Set();
  while (queue.length) {
    const { key, ref } = queue.shift();
    if (visitedKeys.has(key)) continue;
    visitedKeys.add(key);
    if (!graph.has(ref)) graph.set(ref, new Set());
    const entry = packages[key];
    const regular = entry.dependencies ?? {};
    const optional = entry.optionalDependencies ?? {};
    const peers = entry.peerDependencies ?? {};
    for (const name of [
      ...new Set([
        ...Object.keys(regular),
        ...Object.keys(optional),
        ...Object.keys(peers),
      ]),
    ].sort()) {
      const peerOptional =
        entry.peerDependenciesMeta?.[name]?.optional === true;
      addDependency(
        ref,
        key,
        name,
        Object.hasOwn(optional, name) || peerOptional,
      );
    }
  }
  return graph;
}

export async function buildSbom(rootDir, source) {
  await assertReleaseToolchain(rootDir);
  const { packageJson, lock } = await readPackageState(rootDir);
  const { stdout } = await runNpm(
    [
      "sbom",
      "--workspace",
      "@coga/core",
      "--package-lock-only",
      "--sbom-format",
      "cyclonedx",
      "--sbom-type",
      "library",
    ],
    rootDir,
  );
  const raw = JSON.parse(stdout);
  if (raw.bomFormat !== "CycloneDX" || raw.specVersion !== "1.5") {
    throw new Error(
      `npm produced unsupported SBOM ${raw.bomFormat} ${raw.specVersion}.`,
    );
  }
  const graph = buildProductionGraph(packageJson, lock);
  const rootRef = `${packageJson.name}@${packageJson.version}`;
  const components = new Map(
    (raw.components ?? []).map((component) => [
      component["bom-ref"],
      component,
    ]),
  );
  const rootComponent = components.get(rootRef);
  if (!rootComponent)
    throw new Error(`npm SBOM omitted the root component ${rootRef}.`);
  const expectedComponentRefs = [...graph.keys()]
    .filter((ref) => ref !== rootRef)
    .sort();
  const missing = expectedComponentRefs.filter((ref) => !components.has(ref));
  if (missing.length)
    throw new Error(
      `npm SBOM omitted production components: ${missing.join(", ")}.`,
    );

  return canonicalize({
    $schema: "http://cyclonedx.org/schema/bom-1.5.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    metadata: {
      lifecycles: [{ phase: "build" }],
      tools: raw.metadata?.tools,
      component: rootComponent,
      properties: [
        { name: "coga:source:repository", value: source.repository },
        { name: "coga:source:commit", value: source.commit },
        {
          name: "coga:source:tag",
          value: source.tag ?? "unversioned-local-candidate",
        },
      ],
    },
    components: expectedComponentRefs.map((ref) => components.get(ref)),
    dependencies: [...graph.entries()].map(([ref, dependencies]) => ({
      ref,
      dependsOn: [...dependencies].sort(),
    })),
  });
}

function assertEqual(actual, expected, message) {
  if (actual !== expected)
    throw new Error(`${message}: expected ${expected}, got ${actual}.`);
}

export async function verifySbom(rootDir, sbom, source) {
  await assertReleaseToolchain(rootDir);
  const { packageJson, lock } = await readPackageState(rootDir);
  assertEqual(sbom.bomFormat, "CycloneDX", "SBOM format");
  assertEqual(sbom.specVersion, "1.5", "SBOM specification");
  if (
    Object.hasOwn(sbom, "serialNumber") ||
    Object.hasOwn(sbom.metadata ?? {}, "timestamp")
  ) {
    throw new Error(
      "Normalized SBOM must not contain random serialNumber or timestamp fields.",
    );
  }
  const rootRef = `${packageJson.name}@${packageJson.version}`;
  assertEqual(
    sbom.metadata?.component?.["bom-ref"],
    rootRef,
    "SBOM root component",
  );
  const properties = new Map(
    (sbom.metadata?.properties ?? []).map((property) => [
      property.name,
      property.value,
    ]),
  );
  assertEqual(
    properties.get("coga:source:repository"),
    source.repository,
    "SBOM repository",
  );
  assertEqual(
    properties.get("coga:source:commit"),
    source.commit,
    "SBOM commit",
  );
  assertEqual(
    properties.get("coga:source:tag"),
    source.tag ?? "unversioned-local-candidate",
    "SBOM tag",
  );

  const expectedGraph = buildProductionGraph(packageJson, lock);
  const expectedComponents = [...expectedGraph.keys()]
    .filter((ref) => ref !== rootRef)
    .sort();
  const actualComponents = (sbom.components ?? [])
    .map((component) => component["bom-ref"])
    .sort();
  assertEqual(
    JSON.stringify(actualComponents),
    JSON.stringify(expectedComponents),
    "SBOM production component closure",
  );
  if (new Set(actualComponents).size !== actualComponents.length)
    throw new Error("SBOM contains duplicate component identities.");
  const actualGraph = new Map(
    (sbom.dependencies ?? []).map((edge) => [
      edge.ref,
      [...(edge.dependsOn ?? [])].sort(),
    ]),
  );
  assertEqual(
    actualGraph.size,
    expectedGraph.size,
    "SBOM dependency node count",
  );
  for (const [ref, dependencies] of expectedGraph) {
    if (!actualGraph.has(ref))
      throw new Error(`SBOM dependency graph omitted ${ref}.`);
    assertEqual(
      JSON.stringify(actualGraph.get(ref)),
      JSON.stringify([...dependencies].sort()),
      `SBOM dependencies for ${ref}`,
    );
  }
  if (canonicalJson(sbom) !== `${JSON.stringify(sbom, null, 2)}\n`)
    throw new Error("SBOM JSON is not canonicalized.");
}

async function packCore(rootDir, outputDir) {
  const resolvedRoot = path.resolve(rootDir);
  const distDir = path.resolve(resolvedRoot, "packages", "core", "dist");
  if (
    path.relative(resolvedRoot, distDir).replaceAll("\\", "/") !==
    "packages/core/dist"
  ) {
    throw new Error("Refusing to clean an unexpected Core build directory.");
  }
  await rm(distDir, { recursive: true, force: true });
  await runNpm(["run", "build", "--workspace", "@coga/core"], rootDir);
  const { stdout } = await runNpm(
    [
      "pack",
      "--workspace",
      "@coga/core",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      outputDir,
    ],
    rootDir,
  );
  const result = JSON.parse(stdout);
  if (!Array.isArray(result) || result.length !== 1)
    throw new Error("npm pack did not return exactly one package.");
  const inventory = result[0];
  if (!inventory.files?.some((file) => file.path === "LICENSE"))
    throw new Error("npm pack inventory omitted LICENSE.");
  return { inventory, file: path.join(outputDir, inventory.filename) };
}

export async function generateRelease(rootDir, outputDir, source) {
  const resolvedOutput = path.resolve(outputDir);
  const resolvedRoot = path.resolve(rootDir);
  if (
    resolvedOutput === resolvedRoot ||
    isPathInside(resolvedRoot, resolvedOutput)
  ) {
    throw new Error(
      "Release output directory must be outside the Git workspace.",
    );
  }
  await mkdir(resolvedOutput, { recursive: true });
  outputDir = await assertExternalReleaseDirectory(rootDir, resolvedOutput);
  if ((await readdir(outputDir)).length)
    throw new Error(`Release output directory must be empty: ${outputDir}`);
  const { packageJson } = await readPackageState(rootDir);
  const { inventory, file: packageFile } = await packCore(rootDir, outputDir);
  const sbomName = `coga-core-${packageJson.version}.cdx.json`;
  const manifestName = `coga-core-${packageJson.version}.release.json`;
  const sbomFile = path.join(outputDir, sbomName);
  const manifestFile = path.join(outputDir, manifestName);
  const sbom = await buildSbom(rootDir, source);
  await writeFile(sbomFile, canonicalJson(sbom), "utf8");
  const artifacts = [];
  for (const [file, mediaType] of [
    [packageFile, "application/vnd.npm.package+gzip"],
    [sbomFile, "application/vnd.cyclonedx+json"],
  ]) {
    const content = await readFile(file);
    artifacts.push({
      path: path.basename(file),
      mediaType,
      size: content.length,
      sha256: sha256(content),
    });
  }
  const manifest = {
    schemaVersion: RELEASE_SCHEMA,
    package: { name: packageJson.name, version: packageJson.version },
    source,
    artifacts,
  };
  await writeFile(manifestFile, canonicalJson(manifest), "utf8");
  return { manifest, inventory, files: [packageFile, sbomFile, manifestFile] };
}

export function readTarEntries(buffer, limits = RELEASE_LIMITS) {
  if (buffer.length > limits.packageBytes) {
    throw new Error(
      `Release package exceeds the ${limits.packageBytes}-byte safety budget.`,
    );
  }
  let tar;
  try {
    tar = gunzipSync(buffer, { maxOutputLength: limits.unpackedBytes });
  } catch (error) {
    throw new Error(
      `Release package is invalid or exceeds the ${limits.unpackedBytes}-byte unpacked safety budget.`,
      { cause: error },
    );
  }
  const entries = new Map();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const stringField = (start, length) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .replace(/\0.*$/u, "");
    const prefix = stringField(345, 155);
    const name = `${prefix}${prefix ? "/" : ""}${stringField(0, 100)}`;
    const sizeText = stringField(124, 12).trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0)
      throw new Error(`Invalid tar entry size for ${name}.`);
    if (path.posix.isAbsolute(name) || name.split("/").includes(".."))
      throw new Error(`Unsafe tar entry ${name}.`);
    const contentStart = offset + 512;
    const contentEnd = contentStart + size;
    if (contentEnd > tar.length)
      throw new Error(`Tar entry ${name} exceeds the archive boundary.`);
    if (entries.has(name)) throw new Error(`Duplicate tar entry ${name}.`);
    if (entries.size >= limits.tarEntries)
      throw new Error(
        `Release package exceeds the ${limits.tarEntries}-entry safety budget.`,
      );
    entries.set(name, tar.subarray(contentStart, contentEnd));
    const nextOffset = contentStart + Math.ceil(size / 512) * 512;
    if (nextOffset > tar.length)
      throw new Error(
        `Tar entry ${name} padding exceeds the archive boundary.`,
      );
    offset = nextOffset;
  }
  return entries;
}

export async function verifyRelease(rootDir, outputDir, source) {
  outputDir = await assertExternalReleaseDirectory(rootDir, outputDir);
  const { packageJson } = await readPackageState(rootDir);
  const manifestName = `coga-core-${packageJson.version}.release.json`;
  const manifest = await readJsonBounded(
    path.join(outputDir, manifestName),
    RELEASE_LIMITS.manifestBytes,
    "Release manifest",
  );
  assertEqual(
    manifest.schemaVersion,
    RELEASE_SCHEMA,
    "Release manifest schema",
  );
  assertEqual(manifest.package?.name, packageJson.name, "Release package name");
  assertEqual(
    manifest.package?.version,
    packageJson.version,
    "Release package version",
  );
  assertEqual(
    canonicalJson(manifest.source),
    canonicalJson(source),
    "Release source identity",
  );
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 2) {
    throw new Error(
      "Release manifest must describe exactly the package and SBOM.",
    );
  }
  const expectedNames = new Set([
    `coga-core-${packageJson.version}.tgz`,
    `coga-core-${packageJson.version}.cdx.json`,
  ]);
  for (const artifact of manifest.artifacts) {
    if (
      !expectedNames.delete(artifact.path) ||
      path.basename(artifact.path) !== artifact.path
    ) {
      throw new Error(`Unexpected release artifact path ${artifact.path}.`);
    }
    const limit = artifact.path.endsWith(".tgz")
      ? RELEASE_LIMITS.packageBytes
      : RELEASE_LIMITS.sbomBytes;
    const content = await readFileBounded(
      path.join(outputDir, artifact.path),
      limit,
      `Artifact ${artifact.path}`,
    );
    assertEqual(
      content.length,
      artifact.size,
      `Artifact size for ${artifact.path}`,
    );
    assertEqual(
      sha256(content),
      artifact.sha256,
      `Artifact SHA-256 for ${artifact.path}`,
    );
  }
  if (expectedNames.size)
    throw new Error(
      `Release manifest omitted ${[...expectedNames].join(", ")}.`,
    );
  const directoryFiles = (await readdir(outputDir)).sort();
  const expectedFiles = [
    ...manifest.artifacts.map((artifact) => artifact.path),
    manifestName,
  ].sort();
  assertEqual(
    JSON.stringify(directoryFiles),
    JSON.stringify(expectedFiles),
    "Release output inventory",
  );

  const sbom = await readJsonBounded(
    path.join(outputDir, `coga-core-${packageJson.version}.cdx.json`),
    RELEASE_LIMITS.sbomBytes,
    "Release SBOM",
  );
  await verifySbom(rootDir, sbom, source);
  const tarEntries = readTarEntries(
    await readFileBounded(
      path.join(outputDir, `coga-core-${packageJson.version}.tgz`),
      RELEASE_LIMITS.packageBytes,
      "Release package",
    ),
  );
  const packedPackage = JSON.parse(
    tarEntries.get("package/package.json")?.toString("utf8") ?? "null",
  );
  assertEqual(packedPackage?.name, packageJson.name, "Packed package name");
  assertEqual(
    packedPackage?.version,
    packageJson.version,
    "Packed package version",
  );
  const [rootLicense, packageLicense, packedLicense] = await Promise.all([
    readFile(path.join(rootDir, "LICENSE")),
    readFile(path.join(rootDir, "packages", "core", "LICENSE")),
    Promise.resolve(tarEntries.get("package/LICENSE")),
  ]);
  if (!packedLicense)
    throw new Error("Packed tarball omitted package/LICENSE.");
  assertEqual(
    sha256(packageLicense),
    sha256(rootLicense),
    "Package license copy",
  );
  assertEqual(sha256(packedLicense), sha256(rootLicense), "Packed license");
  return manifest;
}

export async function compareReleaseDirectories(leftDir, rightDir) {
  const leftFiles = (await readdir(leftDir)).sort();
  const rightFiles = (await readdir(rightDir)).sort();
  assertEqual(
    JSON.stringify(leftFiles),
    JSON.stringify(rightFiles),
    "Reproducible release inventory",
  );
  const digest = createHash("sha256");
  for (const name of leftFiles) {
    const [left, right] = await Promise.all([
      readFile(path.join(leftDir, name)),
      readFile(path.join(rightDir, name)),
    ]);
    assertEqual(sha256(left), sha256(right), `Reproducible bytes for ${name}`);
    digest.update(name).update("\0").update(left);
  }
  return { files: leftFiles, payloadSha256: digest.digest("hex") };
}

export async function reproducibilityCheck(rootDir, source) {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "coga-release-repro-"),
  );
  const left = path.join(temporaryRoot, "first");
  const right = path.join(temporaryRoot, "second");
  try {
    await Promise.all([mkdir(left), mkdir(right)]);
    await generateRelease(rootDir, left, source);
    await verifyRelease(rootDir, left, source);
    await generateRelease(rootDir, right, source);
    await verifyRelease(rootDir, right, source);
    return await compareReleaseDirectories(left, right);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

export async function fileInventory(directory) {
  const names = (await readdir(directory)).sort();
  return Promise.all(
    names.map(async (name) => {
      const info = await stat(path.join(directory, name));
      return { name, size: info.size };
    }),
  );
}
