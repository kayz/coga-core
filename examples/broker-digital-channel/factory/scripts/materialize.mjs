import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const workspaceRoot = resolve(import.meta.dirname, "../../../..");
const generatedRoot = resolve(
  workspaceRoot,
  "examples/broker-digital-channel/factory/generated",
);

function loadDocument(path) {
  const text = readFileSync(path, "utf8");
  return path.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
}

function listTemplates(root, current = root) {
  const result = [];
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    if (entry.isSymbolicLink())
      throw new Error(`Template may not contain symbolic links: ${path}`);
    if (entry.isDirectory()) result.push(...listTemplates(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`Unsupported template entry: ${path}`);
  }
  return result.sort();
}

function replaceTokens(text, tokens, source) {
  const rendered = text.replace(/\{\{([a-z][A-Za-z0-9]*)\}\}/gu, (_, name) => {
    if (!(name in tokens))
      throw new Error(`Unknown token ${name} in ${source}`);
    return tokens[name];
  });
  if (/\{\{[a-z][A-Za-z0-9]*\}\}/u.test(rendered))
    throw new Error(`Unresolved token in ${source}`);
  return rendered;
}

export function renderCandidate(candidatePath) {
  const absoluteCandidate = resolve(workspaceRoot, candidatePath);
  const candidate = loadDocument(absoluteCandidate);
  const recipePath = resolve(workspaceRoot, candidate.spec.recipe.path);
  const recipe = loadDocument(recipePath);
  if (
    candidate.spec.recipe.id !== recipe.metadata.id ||
    candidate.spec.recipe.version !== recipe.metadata.version
  ) {
    throw new Error(
      "Candidate recipe reference does not match the loaded recipe",
    );
  }

  const supplied = loadDocument(
    resolve(workspaceRoot, candidate.spec.parametersFile),
  );
  const declaredByCandidate = {
    ...candidate.spec.parameters,
    ...candidate.spec.choices,
  };
  if (JSON.stringify(supplied) !== JSON.stringify(declaredByCandidate)) {
    throw new Error(
      "Factory parameters must exactly preserve the application-owned candidate choices",
    );
  }

  for (const parameter of recipe.spec.parameters) {
    const value = supplied[parameter.name];
    if (parameter.required && typeof value !== "string") {
      throw new Error(`Missing required parameter ${parameter.name}`);
    }
    if (
      typeof value === "string" &&
      !new RegExp(parameter.pattern, "u").test(value)
    ) {
      throw new Error(
        `Parameter ${parameter.name} does not match its recipe pattern`,
      );
    }
  }

  const templateRoot = resolve(dirname(recipePath), recipe.spec.templateRoot);
  const files = new Map();
  for (const source of listTemplates(templateRoot)) {
    const output = relative(templateRoot, source).split(sep).join("/");
    const rendered = replaceTokens(
      readFileSync(source, "utf8"),
      supplied,
      source,
    );
    files.set(output, rendered);
  }

  const expected = [...recipe.spec.outputs].sort();
  const actual = [...files.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Recipe outputs do not match template files\nexpected=${expected}\nactual=${actual}`,
    );
  }
  return { candidate, recipe, files };
}

export function checkGolden(rendered) {
  const goldenRoot = resolve(
    workspaceRoot,
    rendered.candidate.spec.expectedOutputRoot,
  );
  for (const [path, content] of rendered.files) {
    const golden = resolve(goldenRoot, path);
    if (!existsSync(golden)) throw new Error(`Missing golden output: ${path}`);
    if (readFileSync(golden, "utf8") !== content)
      throw new Error(`Golden output differs: ${path}`);
  }
}

function writeGenerated(rendered, outputName) {
  const target = resolve(generatedRoot, outputName);
  const relativeTarget = relative(generatedRoot, target);
  if (relativeTarget.startsWith("..") || relativeTarget === "") {
    throw new Error(
      "Generated output must be a named child of the example factory/generated directory",
    );
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error("Generated output must not exist or must be empty");
  }
  for (const [path, content] of rendered.files) {
    const destination = resolve(target, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, content, "utf8");
  }
  return target;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const [candidatePath, mode = "--check", outputName] = process.argv.slice(2);
  if (!candidatePath)
    throw new Error(
      "Usage: materialize.mjs <candidate-path> [--check | --out <name>]",
    );
  const rendered = renderCandidate(candidatePath);
  if (mode === "--check") checkGolden(rendered);
  else if (mode === "--out" && outputName) writeGenerated(rendered, outputName);
  else throw new Error("Expected --check or --out <name>");
  process.stdout.write(
    `${rendered.recipe.metadata.id}@${rendered.recipe.metadata.version}: ${rendered.files.size} deterministic files\n`,
  );
}
