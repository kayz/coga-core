export function customerAccessState(context, now = new Date()) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return "unavailable";
  }
  if (context.authenticated !== true) return "public";
  if (typeof context.expiresAt !== "string") return "unavailable";
  const expiresAt = new Date(context.expiresAt);
  if (Number.isNaN(expiresAt.valueOf())) return "unavailable";
  if (expiresAt <= now) return "expired";
  return "customer";
}

export function createViewModel(context, now = new Date()) {
  const accessState = customerAccessState(context, now);
  return {
    accessState,
    heading: "Cedar market context",
    sourceLabel: "Fictitious broker learning feed",
    accessLabel:
      accessState === "customer"
        ? "Authenticated customer context"
        : accessState === "public"
          ? "Public summary"
          : accessState === "expired"
            ? "Session expired"
            : "Customer context unavailable",
    canRequestSupport: accessState === "customer",
  };
}
