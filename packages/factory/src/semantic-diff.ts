import { digestJson } from "./canonical.js";

export interface StructuralChange {
  path: string;
  operation: "add" | "remove" | "replace";
  before?: unknown;
  after?: unknown;
}

export interface StructuralDiff {
  beforeDigest: string;
  afterDigest: string;
  changes: StructuralChange[];
  deterministicClasses: string[];
}

function compare(
  before: unknown,
  after: unknown,
  path: string,
  output: StructuralChange[],
): void {
  if (Object.is(before, after)) return;
  if (before === undefined) {
    output.push({ path, operation: "add", after });
    return;
  }
  if (after === undefined) {
    output.push({ path, operation: "remove", before });
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (digestJson(before) !== digestJson(after))
      output.push({ path, operation: "replace", before, after });
    return;
  }
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      compare(
        (before as Record<string, unknown>)[key],
        (after as Record<string, unknown>)[key],
        `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`,
        output,
      );
    }
    return;
  }
  output.push({ path, operation: "replace", before, after });
}

export function structuralDiff(
  before: unknown,
  after: unknown,
): StructuralDiff {
  const changes: StructuralChange[] = [];
  compare(before, after, "", changes);
  const paths = changes.map((entry) => entry.path);
  const deterministicClasses = [
    ...(paths.some((path) => path.includes("/provenance"))
      ? ["provenance-changed"]
      : []),
    ...(paths.some((path) => path.includes("/contractRefs"))
      ? ["contract-changed"]
      : []),
    ...(paths.some((path) => path.includes("/relations"))
      ? ["relations-changed"]
      : []),
    ...(paths.some((path) => path.includes("/validation"))
      ? ["validation-changed"]
      : []),
    ...(paths.some(
      (path) => path.includes("/statement") || path.includes("/scope"),
    )
      ? ["semantic-review-required"]
      : []),
  ];
  return {
    beforeDigest: digestJson(before),
    afterDigest: digestJson(after),
    changes,
    deterministicClasses,
  };
}
