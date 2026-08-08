import { digestJson } from "./canonical.js";

export interface CloudEventObservation {
  specversion: "1.0";
  id: string;
  source: string;
  type: string;
  subject?: string;
  time: string;
  datacontenttype: "application/json";
  data: Record<string, unknown>;
  coga: {
    application: { id: string; version: string };
    scope: "application";
    classification: "public" | "internal" | "restricted";
    retentionDays: number;
    schemaRef: string;
    purpose: string;
    owner: string;
  };
}

export interface IncidentRecord {
  id: string;
  state: "open" | "diagnosing" | "mitigated" | "verifying" | "closed";
  severity: "unassessed" | "sev1" | "sev2" | "sev3" | "sev4";
  application: { id: string; version: string };
  observationIds: string[];
  runbook: { id: string; version: string };
  diagnosis?: string;
  repairCandidateDigest?: string;
  closure: {
    severityAssignedByHuman: boolean;
    criticalJourneyPassed: boolean;
    monitoringRecovered: boolean;
    regressionEvidenceDigest?: string;
    deploymentSucceeded?: boolean;
  };
}

export interface PromotionCandidate {
  id: string;
  lifecycle: "candidate";
  scope: "instance";
  incidentIds: string[];
  targetPackage: { id: string; version: string };
  candidateArtifact: Record<string, unknown>;
  candidateDigest: string;
  generalization: {
    consumerApplications: string[];
    authoritativeSources: string[];
    privateTermsScanPassed: boolean;
    independentScenarios: string[];
  };
  requiresHumanApproval: true;
}

export function normalizeApplicationObservation(
  value: unknown,
  binding: {
    application: { id: string; version: string };
    telemetryRegistry?: string;
  },
): CloudEventObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Application observation fixture must be an object.");
  }
  const source = value as Record<string, unknown>;
  if (source.coga) return source as unknown as CloudEventObservation;
  const data = source.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Application observation fixture has no data object.");
  }
  const record = data as Record<string, unknown>;
  const application = record.application;
  if (
    !application ||
    typeof application !== "object" ||
    Array.isArray(application) ||
    (application as Record<string, unknown>).id !== binding.application.id ||
    (application as Record<string, unknown>).version !==
      binding.application.version
  ) {
    throw new Error(
      "Application observation does not match its attached binding.",
    );
  }
  const events = Array.isArray(record.events) ? record.events : [];
  const governance = events
    .map((entry) =>
      entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).governance
        : undefined,
    )
    .filter((entry): entry is Record<string, unknown> =>
      Boolean(entry && typeof entry === "object"),
    );
  const retentionDays = Math.max(
    1,
    ...governance.map((entry) =>
      typeof entry.retentionDays === "number"
        ? Math.min(365, Math.max(1, entry.retentionDays))
        : 30,
    ),
  );
  const classifications = [
    String(record.classification ?? "restricted"),
    ...governance.map((entry) => String(entry.classification ?? "internal")),
  ];
  const classification = classifications.includes("restricted")
    ? "restricted"
    : classifications.includes("internal")
      ? "internal"
      : "public";
  return {
    specversion: "1.0",
    id: String(source.id ?? ""),
    source: String(source.source ?? ""),
    type: String(source.type ?? ""),
    ...(typeof source.subject === "string" ? { subject: source.subject } : {}),
    time: String(source.time ?? ""),
    datacontenttype: "application/json",
    data: record,
    coga: {
      application: binding.application,
      scope: "application",
      classification,
      retentionDays,
      schemaRef:
        binding.telemetryRegistry ?? "urn:coga:application:telemetry-registry",
      purpose:
        "Import governed local Application telemetry into the factory incident loop.",
      owner: String(governance[0]?.owner ?? "application.owner"),
    },
  };
}

export function validateObservation(
  value: unknown,
  now = new Date(),
): CloudEventObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Observation must be a CloudEvents object.");
  }
  const event = value as Partial<CloudEventObservation>;
  if (event.specversion !== "1.0")
    throw new Error("Observation must use CloudEvents specversion 1.0.");
  if (!event.id || !event.source || !event.type || !event.time) {
    throw new Error("Observation requires id, source, type, and time.");
  }
  if (
    event.datacontenttype !== "application/json" ||
    !event.data ||
    Array.isArray(event.data)
  ) {
    throw new Error("Observation data must be an application/json object.");
  }
  if (!event.coga || event.coga.scope !== "application") {
    throw new Error("Runtime observations must remain application-scoped.");
  }
  if (
    !Number.isInteger(event.coga.retentionDays) ||
    event.coga.retentionDays < 1 ||
    event.coga.retentionDays > 365
  ) {
    throw new Error("Observation retentionDays must be between 1 and 365.");
  }
  const observed = Date.parse(event.time);
  if (!Number.isFinite(observed))
    throw new Error("Observation time is invalid.");
  if (observed > now.getTime() + 300_000)
    throw new Error("Observation time is in the future.");
  const expires = observed + event.coga.retentionDays * 86_400_000;
  if (expires < now.getTime())
    throw new Error("Observation is outside its retention window.");
  return event as CloudEventObservation;
}

export function openIncident(input: {
  id: string;
  observations: CloudEventObservation[];
  runbook: { id: string; version: string };
}): IncidentRecord {
  if (!input.observations.length)
    throw new Error("Incident requires at least one observation.");
  const application = input.observations[0]?.coga.application;
  if (!application)
    throw new Error("Incident observation has no application reference.");
  if (
    input.observations.some(
      (entry) => entry.coga.application.id !== application.id,
    )
  ) {
    throw new Error(
      "One incident may not silently combine different applications.",
    );
  }
  return {
    id: input.id,
    state: "open",
    severity: "unassessed",
    application,
    observationIds: input.observations.map((entry) => entry.id).sort(),
    runbook: input.runbook,
    closure: {
      severityAssignedByHuman: false,
      criticalJourneyPassed: false,
      monitoringRecovered: false,
    },
  };
}

export function canCloseIncident(incident: IncidentRecord): {
  allowed: boolean;
  reasons: string[];
} {
  const reasons: string[] = [];
  if (
    !incident.closure.severityAssignedByHuman ||
    incident.severity === "unassessed"
  ) {
    reasons.push("A human must assign incident severity.");
  }
  if (!incident.closure.criticalJourneyPassed)
    reasons.push("The critical user journey has not passed.");
  if (!incident.closure.monitoringRecovered)
    reasons.push("Monitoring recovery has not been verified.");
  if (!incident.closure.regressionEvidenceDigest)
    reasons.push("Regression evidence is missing.");
  return { allowed: reasons.length === 0, reasons };
}

export function closeIncident(incident: IncidentRecord): IncidentRecord {
  const decision = canCloseIncident(incident);
  if (!decision.allowed)
    throw new Error(`Incident cannot close: ${decision.reasons.join(" ")}`);
  return { ...incident, state: "closed" };
}

export function proposePromotion(input: {
  id: string;
  incidents: IncidentRecord[];
  targetPackage: { id: string; version: string };
  candidateArtifact: Record<string, unknown>;
  consumerApplications: string[];
  authoritativeSources: string[];
  privateTermsScanPassed: boolean;
  independentScenarios: string[];
}): PromotionCandidate {
  if (!input.incidents.length)
    throw new Error("Promotion requires incident evidence.");
  if (input.incidents.some((entry) => entry.state !== "closed")) {
    throw new Error(
      "Promotion requires closed incidents with recovery evidence.",
    );
  }
  if (!input.privateTermsScanPassed)
    throw new Error("Promotion candidate failed private-term sanitization.");
  if (!input.independentScenarios.length)
    throw new Error("Promotion requires an independent scenario.");
  if (
    input.consumerApplications.length < 2 &&
    input.authoritativeSources.length === 0
  ) {
    throw new Error(
      "One-application observation needs an authoritative source before promotion.",
    );
  }
  const candidateDigest = digestJson(input.candidateArtifact);
  return {
    id: input.id,
    lifecycle: "candidate",
    scope: "instance",
    incidentIds: input.incidents.map((entry) => entry.id).sort(),
    targetPackage: input.targetPackage,
    candidateArtifact: input.candidateArtifact,
    candidateDigest,
    generalization: {
      consumerApplications: [...new Set(input.consumerApplications)].sort(),
      authoritativeSources: [...new Set(input.authoritativeSources)].sort(),
      privateTermsScanPassed: true,
      independentScenarios: [...new Set(input.independentScenarios)].sort(),
    },
    requiresHumanApproval: true,
  };
}
