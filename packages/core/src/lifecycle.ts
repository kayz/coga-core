import type { Lifecycle, LifecycleTransitionResult } from "./types.js";

const nextLifecycle: Record<Lifecycle, Lifecycle | undefined> = {
  draft: "candidate",
  candidate: "approved",
  approved: "published",
  published: "deprecated",
  deprecated: undefined,
};

/** Check the explicit monotonic lifecycle graph used by COGA 0.1. */
export function checkLifecycleTransition(
  from: Lifecycle,
  to: Lifecycle,
): LifecycleTransitionResult {
  if (from === to) {
    return {
      allowed: true,
      from,
      to,
      reason: "The resource remains in its current state.",
    };
  }
  if (nextLifecycle[from] === to) {
    return { allowed: true, from, to, reason: `${from} may advance to ${to}.` };
  }
  return {
    allowed: false,
    from,
    to,
    reason: `COGA 0.1 does not allow lifecycle transition ${from} -> ${to}; transitions must advance one governed state at a time.`,
  };
}

export function canTransitionLifecycle(
  from: Lifecycle,
  to: Lifecycle,
): boolean {
  return checkLifecycleTransition(from, to).allowed;
}
