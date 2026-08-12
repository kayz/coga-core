export function accessState(context, now = new Date()) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return "unavailable";
  }
  if (context.authenticated !== true) return "public";
  if (typeof context.expiresAt !== "string") return "unavailable";
  const expiresAt = new Date(context.expiresAt);
  if (Number.isNaN(expiresAt.valueOf())) return "unavailable";
  return expiresAt > now ? "customer" : "expired";
}

export function viewModel(context, now = new Date()) {
  const state = accessState(context, now);
  return {
    state,
    heading: "Birch research brief",
    source: "Fictitious learning desk",
    access:
      state === "customer"
        ? "Customer support available"
        : state === "public"
          ? "Public learning brief"
          : state === "expired"
            ? "Customer session expired"
            : "Customer support unavailable",
    supportEnabled: state === "customer",
  };
}
