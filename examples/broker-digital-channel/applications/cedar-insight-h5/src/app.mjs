import { createViewModel } from "./domain.mjs";

export function renderPage(document, context, now = new Date()) {
  const model = createViewModel(context, now);
  document.querySelector("[data-heading]").textContent = model.heading;
  document.querySelector("[data-source]").textContent = model.sourceLabel;
  document.querySelector("[data-access]").textContent = model.accessLabel;
  const support = document.querySelector("[data-support]");
  support.hidden = !model.canRequestSupport;
  return model;
}

if (typeof document !== "undefined") {
  renderPage(document, { authenticated: false });
}
