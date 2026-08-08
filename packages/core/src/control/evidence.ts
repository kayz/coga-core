import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { sha256 } from "./canonical.js";
import type {
  ControlValidationIssue,
  EvidenceBundle,
  MaterialRef,
} from "./types.js";

export interface EvidenceVerificationOptions {
  baseDir: string;
  requiredClaims?: string[];
  readFile?: (path: string) => Uint8Array;
}

/** Verify evidence bytes and claim coverage; file contents never enter issues or logs. */
export function verifyEvidenceBundle(
  bundle: EvidenceBundle,
  options: EvidenceVerificationOptions,
): ControlValidationIssue[] {
  const issues: ControlValidationIssue[] = [];
  const reader = options.readFile ?? ((path: string) => readFileSync(path));
  const materials: MaterialRef[] = [
    bundle.spec.subject,
    ...bundle.spec.materials,
  ];
  const materialPaths = new Set(materials.map((material) => material.path));
  for (const material of materials) {
    const path = resolve(options.baseDir, material.path);
    try {
      const actual = sha256(reader(path));
      if (actual !== material.digest) {
        issues.push({
          code: "evidence.digest-mismatch",
          message:
            "Evidence material digest does not match the referenced bytes.",
          path: material.path,
        });
      }
    } catch {
      issues.push({
        code: "evidence.material-missing",
        message: "Evidence material cannot be read.",
        path: material.path,
      });
    }
  }
  for (const claim of bundle.spec.claimResults) {
    for (const path of claim.materialPaths) {
      if (!materialPaths.has(path)) {
        issues.push({
          code: "evidence.claim-material-missing",
          message: `Claim '${claim.claim}' references material not declared by this bundle.`,
          path,
        });
      }
    }
  }
  const passed = new Set(
    bundle.spec.claimResults
      .filter((claim) => claim.status === "passed")
      .map((claim) => claim.claim),
  );
  for (const required of options.requiredClaims ?? []) {
    if (!passed.has(required)) {
      issues.push({
        code: "evidence.required-claim-missing",
        message: `Required claim '${required}' has no passing result.`,
        path: "/spec/claimResults",
      });
    }
  }
  return issues;
}
