import { canonicalJson } from "./canonical.js";

export type SemanticChangeClassification = "expanded" | "narrowed" | "changed";

export interface SemanticChange {
  path: string;
  kind: "added" | "removed" | "modified";
  classification: SemanticChangeClassification;
  before?: unknown;
  after?: unknown;
}

function pointerSegment(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function primitiveSet(value: unknown[]): Set<string> | undefined {
  if (
    !value.every(
      (entry) =>
        entry === null ||
        ["string", "number", "boolean"].includes(typeof entry),
    )
  )
    return undefined;
  return new Set(value.map((entry) => canonicalJson(entry)));
}

function arrayClassification(
  before: unknown[],
  after: unknown[],
): SemanticChangeClassification {
  const left = primitiveSet(before);
  const right = primitiveSet(after);
  if (!left || !right) return "changed";
  const leftInsideRight = [...left].every((entry) => right.has(entry));
  const rightInsideLeft = [...right].every((entry) => left.has(entry));
  if (leftInsideRight && right.size > left.size) return "expanded";
  if (rightInsideLeft && left.size > right.size) return "narrowed";
  return "changed";
}

/** Structural diff. Expanded/narrowed is asserted only for provable primitive set inclusion. */
export function semanticDiff(
  before: unknown,
  after: unknown,
): SemanticChange[] {
  const changes: SemanticChange[] = [];
  const visit = (left: unknown, right: unknown, path: string): void => {
    if (canonicalJson(left) === canonicalJson(right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      changes.push({
        path: path || "/",
        kind: "modified",
        classification: arrayClassification(left, right),
        before: structuredClone(left),
        after: structuredClone(right),
      });
      return;
    }
    if (
      left !== null &&
      right !== null &&
      typeof left === "object" &&
      typeof right === "object" &&
      !Array.isArray(left) &&
      !Array.isArray(right)
    ) {
      const leftRecord = left as Record<string, unknown>;
      const rightRecord = right as Record<string, unknown>;
      for (const key of [
        ...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)]),
      ].sort()) {
        const childPath = `${path}/${pointerSegment(key)}`;
        if (!(key in leftRecord))
          changes.push({
            path: childPath,
            kind: "added",
            classification: "changed",
            after: structuredClone(rightRecord[key]),
          });
        else if (!(key in rightRecord))
          changes.push({
            path: childPath,
            kind: "removed",
            classification: "changed",
            before: structuredClone(leftRecord[key]),
          });
        else visit(leftRecord[key], rightRecord[key], childPath);
      }
      return;
    }
    changes.push({
      path: path || "/",
      kind: "modified",
      classification: "changed",
      before: structuredClone(left),
      after: structuredClone(right),
    });
  };
  visit(before, after, "");
  return changes;
}
