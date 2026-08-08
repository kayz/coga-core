import { appendAuditEvent } from "./audit.js";
import { validateApprovalDecision } from "./validation.js";
import type {
  ApprovalDecision,
  ApprovalRequirement,
  RunRecord,
  TaskContract,
} from "./types.js";

function decisionMatchesRun(
  decision: ApprovalDecision,
  run: RunRecord,
): boolean {
  return (
    decision.taskDigest === run.spec.taskDigest &&
    decision.candidateDigest === run.spec.candidateDigest &&
    decision.evidenceDigest === run.spec.evidenceDigest &&
    decision.impactDigest === run.spec.impactDigest
  );
}

export function approvalRequirementSatisfied(
  requirement: ApprovalRequirement,
  task: TaskContract,
  run: RunRecord,
): boolean {
  const approvals = run.spec.approvalDecisions.filter(
    (decision) =>
      decision.requirementId === requirement.id &&
      decision.decision === "approve" &&
      decision.actor.kind === "human" &&
      decisionMatchesRun(decision, run) &&
      decision.actor.roles.some((role) => requirement.roles.includes(role)) &&
      (!requirement.separationOfDuties ||
        decision.actor.id !== task.spec.requestedBy.id),
  );
  return (
    new Set(approvals.map((decision) => decision.actor.id)).size >=
    requirement.minimumApprovals
  );
}

export function approvalsSatisfied(
  task: TaskContract,
  run: RunRecord,
  phase: ApprovalRequirement["phase"],
  requiredIds?: readonly string[],
): boolean {
  const requirements = task.spec.approvals.filter(
    (requirement) =>
      requirement.phase === phase &&
      (!requiredIds || requiredIds.includes(requirement.id)),
  );
  if (
    requiredIds &&
    requiredIds.some(
      (id) => !requirements.some((requirement) => requirement.id === id),
    )
  )
    return false;
  return requirements.every((requirement) =>
    approvalRequirementSatisfied(requirement, task, run),
  );
}

/** Add a human decision only when role, separation, and digest bindings are valid. */
export function recordApprovalDecision(
  task: TaskContract,
  run: RunRecord,
  decision: ApprovalDecision,
): RunRecord {
  if (decision.actor.kind !== "human")
    throw new Error("Agents and systems cannot approve.");
  const validation = validateApprovalDecision(decision);
  if (!validation.valid)
    throw new Error(
      `Invalid ApprovalDecision: ${validation.issues[0]?.message ?? "unknown"}`,
    );
  if (run.spec.state !== "awaitingApproval")
    throw new Error(
      "Approval decisions may be recorded only while a run awaits approval.",
    );
  const requirement = task.spec.approvals.find(
    (candidate) => candidate.id === decision.requirementId,
  );
  if (!requirement)
    throw new Error(
      `Unknown approval requirement '${decision.requirementId}'.`,
    );
  if (!decision.actor.roles.some((role) => requirement.roles.includes(role)))
    throw new Error("Approver does not hold a required role.");
  if (
    requirement.separationOfDuties &&
    decision.actor.id === task.spec.requestedBy.id
  )
    throw new Error(
      "Separation of duties forbids the task requester from approving.",
    );
  if (!decisionMatchesRun(decision, run))
    throw new Error(
      "Approval is stale because task, candidate, evidence, or impact digest changed.",
    );
  const updated = structuredClone(run);
  updated.spec.approvalDecisions = [
    ...updated.spec.approvalDecisions.filter(
      (candidate) =>
        !(
          candidate.requirementId === decision.requirementId &&
          candidate.actor.id === decision.actor.id
        ),
    ),
    decision,
  ];
  if (decision.decision === "reject") {
    updated.spec.state = "rejected";
    updated.spec.stateReason = decision.reason;
  }
  let audit = appendAuditEvent(updated.spec.audit, {
    occurredAt: decision.decidedAt,
    actor: decision.actor,
    type: `approval.${decision.decision}`,
    payload: {
      requirementId: decision.requirementId,
      taskDigest: decision.taskDigest,
      candidateDigest: decision.candidateDigest,
      evidenceDigest: decision.evidenceDigest,
      impactDigest: decision.impactDigest,
    },
  });
  updated.spec.audit = audit.trail;
  updated.spec.auditHead = audit.head;
  if (decision.decision === "reject") {
    audit = appendAuditEvent(updated.spec.audit, {
      occurredAt: decision.decidedAt,
      actor: decision.actor,
      type: "run.rejected",
      payload: { requirementId: decision.requirementId },
    });
    updated.spec.audit = audit.trail;
    updated.spec.auditHead = audit.head;
  }
  return updated;
}
