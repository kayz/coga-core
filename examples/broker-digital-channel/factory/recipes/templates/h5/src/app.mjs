import { renderExplicitState } from "./state.mjs";

const app = document.querySelector("#app");
app.textContent = renderExplicitState("pending");
app.dataset.applicationId = "{{applicationId}}";
