import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { extname } from "node:path";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { parse as parseYaml } from "yaml";
import type {
  AgentProposalReceipt,
  ApplicationFactoryDefinition,
  ProposalCompilationRequest,
  RemoteEvidence,
  WorkOrder,
} from "./types.js";
import { readBoundedFile } from "./utils.js";

const MAX_NODES = 100_000;
const MAX_DEPTH = 64;

function schema(name: string): object {
  return JSON.parse(
    readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8"),
  ) as object;
}

function compiler(document: object): ValidateFunction {
  const require = createRequire(import.meta.url);
  const addFormats = require("ajv-formats") as FormatsPlugin;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return ajv.compile(document);
}

const validateWorkOrder = compiler(schema("work-order.schema.json"));
const validateApplicationFactory = compiler(
  schema("application-factory.schema.json"),
);
const validateAgentProposalReceipt = compiler(
  schema("agent-proposal-receipt.schema.json"),
);
const validateProposalCompilation = compiler(
  schema("proposal-compilation.schema.json"),
);
const validateRemoteEvidence = compiler(schema("remote-evidence.schema.json"));

function inspect(value: unknown, label: string): void {
  const active = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; exiting?: boolean }> = [
    { value, depth: 0 },
  ];
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    if (current.exiting) {
      if (current.value && typeof current.value === "object") {
        active.delete(current.value);
      }
      continue;
    }
    nodes += 1;
    if (nodes > MAX_NODES) throw new Error(`${label} exceeds the node limit.`);
    if (current.depth > MAX_DEPTH)
      throw new Error(`${label} exceeds the depth limit.`);
    if (
      current.value === null ||
      ["string", "number", "boolean"].includes(typeof current.value)
    ) {
      continue;
    }
    if (!current.value || typeof current.value !== "object") {
      throw new Error(`${label} contains a non-JSON value.`);
    }
    if (active.has(current.value))
      throw new Error(`${label} contains a cycle.`);
    active.add(current.value);
    stack.push({ ...current, exiting: true });
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value as Record<string, unknown>);
    for (let index = children.length - 1; index >= 0; index -= 1) {
      stack.push({ value: children[index], depth: current.depth + 1 });
    }
  }
}

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? [])
    .map(
      (error) =>
        `${error.instancePath || "/"} ${error.message ?? "is invalid"}`,
    )
    .join("; ");
}

function readDocument(path: string, label: string): unknown {
  const extension = extname(path).toLowerCase();
  if (extension !== ".json" && extension !== ".yaml" && extension !== ".yml") {
    throw new Error(`${label} must use JSON or YAML.`);
  }
  const source = readBoundedFile(path, label).toString("utf8");
  const document =
    extension === ".json"
      ? (JSON.parse(source) as unknown)
      : parseYaml(source, { maxAliasCount: 25, uniqueKeys: true });
  inspect(document, label);
  return document;
}

export function loadWorkOrder(path: string): WorkOrder {
  const document = readDocument(path, "Work Order");
  if (!validateWorkOrder(document)) {
    throw new Error(
      `Invalid Work Order: ${formatErrors(validateWorkOrder.errors)}.`,
    );
  }
  return document as WorkOrder;
}

export function loadApplicationFactory(
  path: string,
): ApplicationFactoryDefinition {
  const document = readDocument(path, "Application Factory definition");
  if (!validateApplicationFactory(document)) {
    throw new Error(
      `Invalid Application Factory definition: ${formatErrors(validateApplicationFactory.errors)}.`,
    );
  }
  return document as ApplicationFactoryDefinition;
}

export function loadAgentProposalReceipt(path: string): AgentProposalReceipt {
  const document = readDocument(path, "Agent Proposal Receipt");
  if (!validateAgentProposalReceipt(document)) {
    throw new Error(
      `Invalid Agent Proposal Receipt: ${formatErrors(validateAgentProposalReceipt.errors)}.`,
    );
  }
  return document as AgentProposalReceipt;
}

export function loadProposalCompilation(
  path: string,
): ProposalCompilationRequest {
  const document = readDocument(path, "Proposal Compilation request");
  if (!validateProposalCompilation(document)) {
    throw new Error(
      `Invalid Proposal Compilation request: ${formatErrors(validateProposalCompilation.errors)}.`,
    );
  }
  return document as ProposalCompilationRequest;
}

export function loadRemoteEvidence(path: string): RemoteEvidence {
  const document = readDocument(path, "Remote Evidence");
  if (!validateRemoteEvidence(document)) {
    throw new Error(
      `Invalid Remote Evidence: ${formatErrors(validateRemoteEvidence.errors)}.`,
    );
  }
  return document as RemoteEvidence;
}
