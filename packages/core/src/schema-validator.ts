import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { isRecord, metadataOf } from "./guards.js";
import type { LoadedResource, ResourceKind, ValidationIssue } from "./types.js";

const schemaFiles = [
  "common.schema.json",
  "domain-artifact.schema.json",
  "harness-package.schema.json",
  "coga-instance.schema.json",
  "application.schema.json",
] as const;

const schemaIds: Record<ResourceKind, string> = {
  DomainArtifact: "https://coga.dev/schemas/v0.1/domain-artifact.schema.json",
  HarnessPackage: "https://coga.dev/schemas/v0.1/harness-package.schema.json",
  CogaInstance: "https://coga.dev/schemas/v0.1/coga-instance.schema.json",
  Application: "https://coga.dev/schemas/v0.1/application.schema.json",
};

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addKeyword({ keyword: "x-coga-ui", schemaType: "object", valid: true });

for (const file of schemaFiles) {
  const path = fileURLToPath(new URL(`../schemas/${file}`, import.meta.url));
  ajv.addSchema(JSON.parse(readFileSync(path, "utf8")) as object);
}

function resourceKind(value: unknown): ResourceKind | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (Object.prototype.hasOwnProperty.call(schemaIds, value.kind)) {
    return value.kind as ResourceKind;
  }
  return undefined;
}

function errorMessage(error: ErrorObject): string {
  const location = error.instancePath || "/";
  if (error.keyword === "additionalProperties") {
    const property = String(error.params.additionalProperty ?? "unknown");
    return `${location} contains unsupported property '${property}'.`;
  }
  return `${location} ${error.message ?? "does not satisfy the schema"}.`;
}

function runSchema(
  validator: ValidateFunction,
  resource: LoadedResource,
): ValidationIssue[] {
  if (validator(resource.document)) return [];
  const metadata = metadataOf(resource.document);
  return (validator.errors ?? []).map((error) => {
    const result: ValidationIssue = {
      severity: "error",
      code: `schema.${error.keyword}`,
      message: errorMessage(error),
      path: resource.path,
    };
    if (metadata) result.resourceId = metadata.id;
    return result;
  });
}

export function validateResourceSchema(
  resource: LoadedResource,
): ValidationIssue[] {
  const kind = resourceKind(resource.document);
  if (!kind) {
    return [
      {
        severity: "error",
        code: "schema.unknown-kind",
        message:
          "Resource kind must be DomainArtifact, HarnessPackage, CogaInstance, or Application.",
        path: resource.path,
      },
    ];
  }
  const validator = ajv.getSchema(schemaIds[kind]);
  if (!validator) throw new Error(`Schema was not registered for ${kind}.`);
  return runSchema(validator, resource);
}
