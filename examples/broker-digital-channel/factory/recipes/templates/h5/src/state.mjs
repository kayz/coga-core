const messages = {
  pending: "Checking authoritative context…",
  ready: "Current context is available.",
  empty: "No content is available.",
  denied: "This capability is not available.",
  error: "Context could not be loaded. Try again.",
};

export function renderExplicitState(state) {
  if (!Object.hasOwn(messages, state))
    throw new Error(`Unknown state: ${state}`);
  return messages[state];
}
