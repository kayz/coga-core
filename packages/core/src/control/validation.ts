import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { Ajv2020, type ErrorObject } from "ajv/dist/2020.js";
import type { FormatsPlugin } from "ajv-formats";
import { verifyAuditTrail } from "./audit.js";
import { canonicalJson, sha256 } from "./canonical.js";
import {
  verifyEvidenceBundle,
  type EvidenceVerificationOptions,
} from "./evidence.js";
import { scanControlSecrets } from "./secret-scan.js";
import type {
  ApprovalDecision,
  AuditEvent,
  ControlResourceDocument,
  ControlValidationIssue,
  ControlValidationResult,
  EvidenceBundle,
  Incident,
  Observation,
  PolicyDecision,
  PromotionProposal,
  RunRecord,
  TaskContract,
} from "./types.js";

const require = createRequire(import.meta.url);
const addFormats = require("ajv-formats") as FormatsPlugin;
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addKeyword({ keyword: "x-coga-ui", schemaType: "object", valid: true });

for (const file of ["common.schema.json", "control.schema.json"] as const) {
  const path = fileURLToPath(new URL(`../../schemas/${file}`, import.meta.url));
  ajv.addSchema(JSON.parse(readFileSync(path, "utf8")) as object);
}

const CONTROL_SCHEMA_ID =
  "https://coga.dev/schemas/control/v0.1/control.schema.json";

function schemaIssues(
  errors: ErrorObject[] | null | undefined,
): ControlValidationIssue[] {
  return (errors ?? []).map((error) => ({
    code: `control.schema.${error.keyword}`,
    message: `${error.instancePath || "/"} ${error.message ?? "does not satisfy the control schema"}.`,
    path: error.instancePath || "/",
  }));
}

function taskSemantics(task: TaskContract): ControlValidationIssue[] {
  const issues: ControlValidationIssue[] = [];
  if (task.spec.workspace.kind !== "workspace")
    issues.push({
      code: "task.workspace-kind",
      message: "Task workspace must reference a workspace adapter.",
      path: "/spec/workspace/kind",
    });
  const stepIds = new Set<string>();
  for (const [index, step] of task.spec.steps.entries()) {
    if (stepIds.has(step.id))
      issues.push({
        code: "task.duplicate-step",
        message: `Duplicate task step '${step.id}'.`,
        path: `/spec/steps/${index}/id`,
      });
    stepIds.add(step.id);
    if (
      !["agent", "tool", "observation", "preview"].includes(step.adapter.kind)
    )
      issues.push({
        code: "task.step-adapter-kind",
        message:
          "Task steps may invoke only agent, tool, observation, or preview adapters.",
        path: `/spec/steps/${index}/adapter/kind`,
      });
    step.validators.forEach((validator, validatorIndex) => {
      if (validator.kind !== "validator")
        issues.push({
          code: "task.validator-kind",
          message: "Step validators must reference validator adapters.",
          path: `/spec/steps/${index}/validators/${validatorIndex}/kind`,
        });
    });
  }
  const approvalIds = new Set<string>();
  task.spec.approvals.forEach((requirement, index) => {
    if (approvalIds.has(requirement.id))
      issues.push({
        code: "task.duplicate-approval",
        message: `Duplicate approval requirement '${requirement.id}'.`,
        path: `/spec/approvals/${index}/id`,
      });
    approvalIds.add(requirement.id);
  });
  task.spec.policies.forEach((check, index) => {
    if (check.evaluator.kind !== "policy")
      issues.push({
        code: "task.policy-adapter-kind",
        message: "Policy checks must reference policy adapters.",
        path: `/spec/policies/${index}/evaluator/kind`,
      });
  });
  const maximumAttempts = task.spec.steps.reduce(
    (total, step) => total + step.maxAttempts,
    0,
  );
  if (maximumAttempts > task.spec.budget.maxAttempts)
    issues.push({
      code: "task.attempt-budget",
      message: "The sum of step maxAttempts exceeds the task attempt budget.",
      path: "/spec/budget/maxAttempts",
    });
  return issues;
}

function evidenceSemantics(bundle: EvidenceBundle): ControlValidationIssue[] {
  const issues: ControlValidationIssue[] = [];
  const materialPaths = new Set<string>();
  for (const [index, material] of [
    bundle.spec.subject,
    ...bundle.spec.materials,
  ].entries()) {
    if (materialPaths.has(material.path)) {
      issues.push({
        code: "evidence.duplicate-material-path",
        message: `Evidence material path '${material.path}' is declared more than once.`,
        path:
          index === 0
            ? "/spec/subject/path"
            : `/spec/materials/${index - 1}/path`,
      });
    }
    materialPaths.add(material.path);
  }
  for (const [index, claim] of bundle.spec.claimResults.entries()) {
    if (claim.validator.kind !== "validator")
      issues.push({
        code: "evidence.validator-kind",
        message: "Claim results must identify a validator adapter.",
        path: `/spec/claimResults/${index}/validator/kind`,
      });
    for (const [materialIndex, path] of claim.materialPaths.entries()) {
      if (!materialPaths.has(path)) {
        issues.push({
          code: "evidence.claim-material-missing",
          message: `Claim '${claim.claim}' references material not declared by this bundle.`,
          path: `/spec/claimResults/${index}/materialPaths/${materialIndex}`,
        });
      }
    }
  }
  if (
    bundle.spec.execution.validator &&
    bundle.spec.execution.validator.kind !== "validator"
  )
    issues.push({
      code: "evidence.execution-validator-kind",
      message:
        "Execution validator metadata must reference a validator adapter.",
      path: "/spec/execution/validator/kind",
    });
  return issues;
}

function runSemantics(run: RunRecord): ControlValidationIssue[] {
  const issues: ControlValidationIssue[] = [];
  const audit = verifyAuditTrail(run.spec.audit, run.spec.auditHead);
  if (!audit.valid)
    issues.push({
      code: "run.audit-invalid",
      message: `Audit trail failed verification: ${audit.reason ?? "unknown"}.`,
      path: `/spec/audit/${audit.index ?? 0}`,
    });
  const stepIds = new Set<string>();
  for (const [index, step] of run.spec.steps.entries()) {
    if (stepIds.has(step.id)) {
      issues.push({
        code: "run.duplicate-step",
        message: `Run step '${step.id}' is duplicated.`,
        path: `/spec/steps/${index}/id`,
      });
    }
    stepIds.add(step.id);
    if (
      step.state === "completed" &&
      (step.outputDigest === undefined || step.claimDigest === undefined)
    ) {
      issues.push({
        code: "run.completed-step-digests-required",
        message:
          "Completed steps require both output and claim digests for deterministic resume.",
        path: `/spec/steps/${index}`,
      });
    }
  }
  if (
    run.spec.state === "succeeded" &&
    run.spec.steps.some((step) => step.state !== "completed")
  ) {
    issues.push({
      code: "run.incomplete-success",
      message: "A succeeded run cannot contain incomplete steps.",
      path: "/spec/steps",
    });
  }
  const recordedAttempts = run.spec.steps.reduce(
    (total, step) => total + step.attempts,
    0,
  );
  if (run.spec.budget.attempts < recordedAttempts) {
    issues.push({
      code: "run.attempt-accounting",
      message:
        "Run budget attempts cannot be lower than recorded step attempts.",
      path: "/spec/budget/attempts",
    });
  }
  if (
    run.spec.state === "rejected" &&
    !run.spec.approvalDecisions.some(
      (decision) => decision.decision === "reject",
    )
  ) {
    issues.push({
      code: "run.rejection-decision-required",
      message: "A rejected run requires a human rejection decision.",
      path: "/spec/approvalDecisions",
    });
  }
  for (const [index, decision] of run.spec.approvalDecisions.entries()) {
    if (decision.actor.kind !== "human")
      issues.push({
        code: "approval.human-only",
        message: "Only humans may issue approval decisions.",
        path: `/spec/approvalDecisions/${index}/actor/kind`,
      });
    const bindings = [
      ["candidateDigest", decision.candidateDigest, run.spec.candidateDigest],
      ["taskDigest", decision.taskDigest, run.spec.taskDigest],
      ["evidenceDigest", decision.evidenceDigest, run.spec.evidenceDigest],
      ["impactDigest", decision.impactDigest, run.spec.impactDigest],
    ] as const;
    for (const [field, actual, expected] of bindings) {
      if (actual !== expected)
        issues.push({
          code: "approval.stale-digest",
          message: "Approval is stale because reviewed digests changed.",
          path: `/spec/approvalDecisions/${index}/${field}`,
        });
    }
  }
  return issues;
}

function observationSemantics(
  observation: Observation,
): ControlValidationIssue[] {
  const issues: ControlValidationIssue[] = [];
  if (observation.spec.cloudEvent.dataschema.length === 0)
    issues.push({
      code: "observation.schema-required",
      message: "Observation CloudEvent must declare dataschema.",
      path: "/spec/cloudEvent/dataschema",
    });
  if (
    observation.spec.retention.class !== "record" &&
    !observation.spec.retention.retainUntil
  )
    issues.push({
      code: "observation.retention-expiry",
      message: "Non-record observations require retainUntil.",
      path: "/spec/retention/retainUntil",
    });
  if (
    observation.spec.retention.retainUntil &&
    Date.parse(observation.spec.retention.retainUntil) <=
      Date.parse(observation.spec.cloudEvent.time)
  ) {
    issues.push({
      code: "observation.retention-order",
      message: "Observation retention must extend beyond the CloudEvent time.",
      path: "/spec/retention/retainUntil",
    });
  }
  if (
    observation.metadata.visibility !== undefined &&
    observation.metadata.visibility !== observation.spec.classification
  ) {
    issues.push({
      code: "observation.classification-mismatch",
      message:
        "Observation metadata visibility must match its data classification.",
      path: "/metadata/visibility",
    });
  }
  return issues;
}

function incidentSemantics(incident: Incident): ControlValidationIssue[] {
  if (incident.spec.status !== "closed") return [];
  if (!incident.spec.closure)
    return [
      {
        code: "incident.closure-required",
        message: "Closed incidents require closure evidence.",
        path: "/spec/closure",
      },
    ];
  if (
    !incident.spec.closure.verification.some((entry) => entry.type !== "deploy")
  )
    return [
      {
        code: "incident.deploy-only-closure",
        message: "A deploy event alone cannot close an incident.",
        path: "/spec/closure/verification",
      },
    ];
  return [];
}

function promotionSemantics(
  proposal: PromotionProposal,
): ControlValidationIssue[] {
  const issues: ControlValidationIssue[] = [];
  if (proposal.metadata.lifecycle !== "candidate")
    issues.push({
      code: "promotion.candidate-only",
      message:
        "Promotion proposals must remain candidate until human-governed publication.",
      path: "/metadata/lifecycle",
    });
  const consumers = new Set(
    proposal.spec.sourceApplications.map((entry) => entry.id),
  );
  if (consumers.size < 2 && proposal.spec.authoritativeSources.length === 0)
    issues.push({
      code: "promotion.insufficient-generalization",
      message:
        "Single-application observations require an authoritative source before promotion.",
      path: "/spec/authoritativeSources",
    });
  return issues;
}

export interface ControlValidationOptions {
  evidence?: EvidenceVerificationOptions;
}

export function validateControlDocument(
  document: unknown,
  options: ControlValidationOptions = {},
): ControlValidationResult {
  const validator = ajv.getSchema(CONTROL_SCHEMA_ID);
  if (!validator) throw new Error("COGA control schema was not registered.");
  const structurallyValid = validator(document);
  const issues = [
    ...schemaIssues(validator.errors),
    ...scanControlSecrets(document),
  ];
  if (
    structurallyValid &&
    document &&
    typeof document === "object" &&
    "kind" in document
  ) {
    const resource = document as ControlResourceDocument;
    if (resource.kind === "TaskContract")
      issues.push(...taskSemantics(resource));
    if (resource.kind === "EvidenceBundle") {
      issues.push(...evidenceSemantics(resource));
      if (options.evidence)
        issues.push(...verifyEvidenceBundle(resource, options.evidence));
    }
    if (resource.kind === "RunRecord") issues.push(...runSemantics(resource));
    if (resource.kind === "Observation")
      issues.push(...observationSemantics(resource));
    if (resource.kind === "Incident")
      issues.push(...incidentSemantics(resource));
    if (resource.kind === "PromotionProposal")
      issues.push(...promotionSemantics(resource));
  }
  return { valid: issues.length === 0, issues };
}

/** Canonical public name for validating any top-level control resource. */
export const validateControlResource = validateControlDocument;

function validateFragment(
  name: "policyDecision" | "approvalDecision" | "auditEvent",
  document: unknown,
): ControlValidationResult {
  const validator = ajv.getSchema(`${CONTROL_SCHEMA_ID}#/$defs/${name}`);
  if (!validator) throw new Error(`COGA ${name} schema was not registered.`);
  const valid = validator(document);
  const issues = [
    ...schemaIssues(validator.errors),
    ...scanControlSecrets(document),
  ];
  return { valid: Boolean(valid) && issues.length === 0, issues };
}

export const validatePolicyDecision = (
  document: unknown,
): ControlValidationResult => {
  const result = validateFragment("policyDecision", document as PolicyDecision);
  if (!result.valid || document === null || typeof document !== "object")
    return result;
  const decision = document as PolicyDecision;
  const issues = [...result.issues];
  if (decision.evaluator.kind !== "policy") {
    issues.push({
      code: "policy.evaluator-kind",
      message:
        "Policy decisions must identify the policy adapter that evaluated them.",
      path: "/evaluator/kind",
    });
  }
  if (
    decision.decision === "requireApproval" &&
    decision.approvalRequirementIds.length === 0
  ) {
    issues.push({
      code: "policy.approval-requirement-required",
      message:
        "A requireApproval decision must name at least one approval requirement.",
      path: "/approvalRequirementIds",
    });
  }
  if (
    decision.decision !== "requireApproval" &&
    decision.approvalRequirementIds.length > 0
  ) {
    issues.push({
      code: "policy.unexpected-approval-requirement",
      message: "Only requireApproval decisions may name approval requirements.",
      path: "/approvalRequirementIds",
    });
  }
  return { valid: issues.length === 0, issues };
};
export const validateApprovalDecision = (
  document: unknown,
): ControlValidationResult =>
  validateFragment("approvalDecision", document as ApprovalDecision);
export const validateAuditEvent = (
  document: unknown,
): ControlValidationResult => {
  const result = validateFragment("auditEvent", document as AuditEvent);
  if (!result.valid || document === null || typeof document !== "object")
    return result;
  const event = document as AuditEvent;
  const issues = [...result.issues];
  if (event.payloadDigest !== sha256(event.payload)) {
    issues.push({
      code: "audit.payload-digest-mismatch",
      message: "Audit payload digest does not match its canonical payload.",
      path: "/payloadDigest",
    });
  }
  const { hash: _hash, ...withoutHash } = event;
  if (event.hash !== sha256(canonicalJson(withoutHash))) {
    issues.push({
      code: "audit.hash-mismatch",
      message: "Audit event hash does not match its canonical fields.",
      path: "/hash",
    });
  }
  return { valid: issues.length === 0, issues };
};

export function loadControlDocument(path: string): unknown {
  const absolute = resolve(path);
  const source = readFileSync(absolute, "utf8");
  const extension = extname(absolute).toLowerCase();
  if (extension === ".json") return JSON.parse(source) as unknown;
  if (extension === ".yaml" || extension === ".yml")
    return parseYaml(source, { maxAliasCount: 50, uniqueKeys: true });
  throw new Error("Control documents must use .yaml, .yml, or .json.");
}
