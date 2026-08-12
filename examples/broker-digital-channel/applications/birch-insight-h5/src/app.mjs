import { viewModel } from "./domain.mjs";

export function render(document, context, now = new Date()) {
  const model = viewModel(context, now);
  document.querySelector("[data-heading]").textContent = model.heading;
  document.querySelector("[data-source]").textContent = model.source;
  document.querySelector("[data-access]").textContent = model.access;
  document.querySelector("[data-support]").disabled = !model.supportEnabled;
  return model;
}

if (typeof document !== "undefined") {
  render(document, { authenticated: false });
}
