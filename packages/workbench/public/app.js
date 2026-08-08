const state = {
  token: "",
  snapshot: null,
  activeTaskId: null,
  activePanel: "intent",
  impact: null,
  observationStoreId: null,
  incidentId: null,
  toastTimer: null,
};

const byId = (id) => document.getElementById(id);
const text = (tag, value, className) => {
  const node = document.createElement(tag);
  node.textContent = value;
  if (className) node.className = className;
  return node;
};

function showToast(message, error = false) {
  const node = byId("toast");
  node.textContent = message;
  node.classList.toggle("is-error", error);
  node.classList.add("is-visible");
  if (state.toastTimer) window.clearTimeout(state.toastTimer);
  state.toastTimer = window.setTimeout(
    () => node.classList.remove("is-visible"),
    4200,
  );
}

async function request(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (options.method && options.method !== "GET")
    headers["x-coga-action-token"] = state.token;
  const response = await fetch(path, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response
    .json()
    .catch(() => ({ error: `HTTP ${response.status}` }));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
  return payload;
}

function setPanel(name) {
  state.activePanel = name;
  document.querySelectorAll(".work-panel").forEach((panel) => {
    panel.classList.toggle("is-visible", panel.dataset.panel === name);
  });
  document.querySelectorAll(".spine__station").forEach((station) => {
    station.classList.toggle("is-current", station.dataset.panel === name);
  });
  byId(`panel-${name}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

function catalogCounts(snapshot) {
  const packages = snapshot.catalog?.packages ?? [];
  return {
    packages: packages.length,
    artifacts: packages.reduce(
      (count, entry) => count + (entry.artifacts?.length ?? 0),
      0,
    ),
    applications: snapshot.catalog?.applications?.length ?? 0,
  };
}

function runFor(taskId) {
  return (state.snapshot?.runs ?? []).find(
    (run) => run.spec?.task?.id === taskId,
  );
}

function taskFor(taskId) {
  return (state.snapshot?.tasks ?? []).find(
    (task) => task.metadata?.id === taskId,
  );
}

function candidateForTask(taskId) {
  const candidateId = taskFor(taskId)?.spec?.steps?.[0]?.input?.candidateId;
  return (state.snapshot?.candidates ?? []).find(
    (candidate) => candidate.id === candidateId,
  );
}

function evidenceFor(taskId) {
  return (state.snapshot?.evidence ?? []).filter(
    (entry) => entry.spec?.task?.id === taskId,
  );
}

function compact(value, limit = 240) {
  const result = value === undefined ? "—" : JSON.stringify(value);
  return result.length <= limit ? result : `${result.slice(0, limit - 1)}…`;
}

function renderQueue() {
  const target = byId("task-queue");
  target.replaceChildren();
  const tasks = [...(state.snapshot?.tasks ?? [])].reverse();
  if (!tasks.length) {
    target.className = "task-queue empty-state";
    target.append(
      text("strong", "尚无候选"),
      text("p", "用左侧表单创建第一条治理轨迹。"),
    );
    return;
  }
  target.className = "task-queue";
  for (const task of tasks) {
    const run = runFor(task.metadata.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "task-item";
    button.dataset.taskId = task.metadata.id;
    button.dataset.status = run?.spec?.state ?? "created";
    button.classList.toggle(
      "is-active",
      task.metadata.id === state.activeTaskId,
    );
    button.append(
      text("strong", task.spec?.intent?.goal ?? task.metadata.id),
      text(
        "small",
        `${task.spec?.risk ?? "—"} · ${run?.spec?.state ?? "created"}`,
      ),
    );
    target.append(button);
  }
}

function renderDiff() {
  const candidate = state.activeTaskId
    ? candidateForTask(state.activeTaskId)
    : null;
  const target = byId("semantic-diff");
  target.replaceChildren();
  if (!candidate) {
    target.className = "diff-table empty-state";
    target.append(text("p", "创建或选择候选后显示字段级变化。"));
    byId("diff-summary").textContent = "选择一个任务";
    return;
  }
  const changes = candidate.diff?.changes ?? [];
  byId("diff-summary").textContent =
    `${changes.length} 个结构变化 · ${candidate.artifactId}`;
  target.className = "diff-table";
  for (const change of changes) {
    const row = document.createElement("div");
    row.className = "diff-row";
    const operation = text("span", change.operation, "diff-op");
    operation.dataset.op = change.operation;
    row.append(
      operation,
      text("code", change.path || "/"),
      text("code", compact(change.before), "diff-before"),
      text("code", compact(change.after), "diff-after"),
    );
    target.append(row);
  }
  if (!changes.length)
    target.append(text("p", "候选与基线摘要一致。", "empty-state"));
}

function renderProvenance() {
  const target = byId("provenance-list");
  target.replaceChildren();
  const sources = state.activeTaskId
    ? (taskFor(state.activeTaskId)?.spec?.steps?.[0]?.input?.sources ?? [])
    : [];
  if (!sources.length) {
    target.className = "source-list empty-state";
    target.append(text("p", "暂无来源。"));
    return;
  }
  target.className = "source-list";
  for (const source of sources) {
    const item = document.createElement("div");
    item.className = "source-item";
    item.append(
      text("strong", source.authority),
      text("span", `${source.sourceType} · ${source.visibility}`),
      text("code", source.uri),
      text("code", `sha256:${source.digest}`),
    );
    target.append(item);
  }
}

function renderImpact() {
  const target = byId("impact-graph");
  target.replaceChildren();
  if (!state.impact) {
    target.className = "impact-graph empty-state";
    target.append(text("p", "影响路径尚未计算。"));
    return;
  }
  target.className = "impact-graph";
  const artifactId =
    state.impact.artifactId ??
    candidateForTask(state.activeTaskId)?.artifactId ??
    "artifact";
  const packages = state.impact.packages ?? [];
  const applications =
    state.impact.affectedApplications ?? state.impact.applications ?? [];
  if (!applications.length) {
    target.append(
      text("p", "没有找到锁定此 Harness 的 Application。", "empty-state"),
    );
    return;
  }
  for (const application of applications) {
    const path = document.createElement("div");
    path.className = "impact-path";
    path.append(
      text("span", artifactId, "impact-node"),
      text("span", "→", "impact-arrow"),
    );
    for (const pkg of packages) {
      path.append(
        text("span", pkg.id, "impact-node"),
        text("span", "→", "impact-arrow"),
      );
    }
    path.append(text("span", application.id, "impact-node"));
    target.append(path);
  }
  const reruns = state.impact.rerunScenarios ?? [];
  if (reruns.length)
    target.append(text("p", `需重跑：${reruns.join(" · ")}`, "empty-state"));
}

function renderModelEvidence(entries) {
  const target = byId("model-evidence");
  target.replaceChildren();
  const result = [...(state.snapshot?.assessmentResults ?? [])]
    .reverse()
    .find((entry) => entry.taskId === state.activeTaskId);
  if (!result?.assessment) {
    target.className = "empty-state";
    target.append(text("p", "尚未运行评估。"));
    return;
  }
  target.className = "";
  const assessment = result.assessment;
  target.append(
    text("p", assessment.summary, "assessment-summary"),
    text(
      "span",
      `${assessment.recommendation} · confidence ${Number(assessment.confidence).toFixed(2)}`,
      "assessment-verdict",
    ),
  );
  if (assessment.changeClasses?.length) {
    target.append(
      text(
        "p",
        `变化分类：${assessment.changeClasses.join(" · ")}`,
        "empty-state",
      ),
    );
  }
  const riskList = document.createElement("ul");
  riskList.className = "risk-list";
  for (const risk of assessment.risks ?? []) {
    riskList.append(
      text("li", `[${risk.severity}] ${risk.description} — ${risk.mitigation}`),
    );
  }
  target.append(riskList);
  const questions = document.createElement("ul");
  questions.className = "question-list";
  for (const question of assessment.questions ?? [])
    questions.append(text("li", question));
  target.append(questions);
}

function renderValidatorEvidence(entries) {
  const target = byId("validator-evidence");
  target.replaceChildren();
  const commandEvidence = entries.filter(
    (entry) => entry.spec?.execution?.command,
  );
  if (!commandEvidence.length) {
    target.className = "claim-list empty-state";
    target.append(text("p", "尚无命令证据。"));
    return;
  }
  target.className = "claim-list";
  for (const evidence of commandEvidence) {
    for (const claim of evidence.spec.claimResults ?? []) {
      const item = document.createElement("div");
      item.className = "claim-item";
      item.dataset.status = claim.status;
      item.append(
        text("strong", claim.claim),
        text(
          "span",
          `${claim.status} · exit ${evidence.spec.execution.command.exitCode}`,
        ),
      );
      target.append(item);
    }
  }
}

function renderDigests(entries) {
  const target = byId("digest-board");
  target.replaceChildren();
  if (!entries.length) {
    target.className = "digest-board empty-state";
    target.append(text("p", "完成评估后显示。"));
    return;
  }
  target.className = "digest-board";
  for (const evidence of entries) {
    const item = document.createElement("div");
    item.className = "digest-item";
    const digest =
      evidence.spec?.execution?.model?.outputDigest ??
      evidence.spec?.execution?.command?.stdoutDigest ??
      evidence.spec?.subject?.digest ??
      "—";
    item.append(
      text("span", evidence.metadata?.title ?? "evidence"),
      text("code", digest),
    );
    target.append(item);
  }
}

function renderEvidence() {
  const entries = state.activeTaskId ? evidenceFor(state.activeTaskId) : [];
  renderModelEvidence(entries);
  renderValidatorEvidence(entries);
  renderDigests(entries);
}

function renderAudit() {
  const target = byId("audit-timeline");
  target.replaceChildren();
  const events = state.snapshot?.audit ?? [];
  if (!events.length) {
    target.className = "audit-timeline empty-state";
    target.append(text("p", "尚无审计事件。"));
  } else {
    target.className = "audit-timeline";
    for (const event of [...events].reverse()) {
      const item = document.createElement("article");
      item.className = "audit-event";
      const time = document.createElement("time");
      time.dateTime = event.timestamp;
      time.textContent = event.timestamp
        .replace("T", " ")
        .replace(".000Z", "Z");
      item.append(
        time,
        text("strong", event.type),
        text("code", `${event.actor?.id ?? "system"} · ${event.hash}`),
      );
      target.append(item);
    }
  }
  const metricsTarget = byId("change-metrics");
  metricsTarget.replaceChildren();
  const metrics = state.snapshot?.metrics ?? [];
  if (!metrics.length) {
    metricsTarget.className = "metric-list empty-state";
    metricsTarget.append(text("p", "完成第一个候选后开始积累。"));
    return;
  }
  metricsTarget.className = "metric-list";
  for (const [index, metric] of metrics.entries()) {
    const item = document.createElement("div");
    item.className = "metric-item";
    item.append(
      text("span", `CHANGE ${String(index + 1).padStart(2, "0")}`),
      text("strong", `${metric.durationMs ?? "—"} ms`),
      text(
        "small",
        `${metric.attempts} 次执行 · ${metric.manualGates} 个人工门 · ${metric.reusedScenarios} 项复用证据`,
      ),
    );
    metricsTarget.append(item);
  }
}

function renderSpine() {
  const task = state.activeTaskId ? taskFor(state.activeTaskId) : null;
  const run = state.activeTaskId ? runFor(state.activeTaskId) : null;
  const completed = new Set();
  if (task) completed.add("intent");
  if (task) completed.add("candidate");
  if (run?.spec?.steps?.some((entry) => entry.state === "completed"))
    completed.add("evidence");
  if (["succeeded", "rejected"].includes(run?.spec?.state))
    completed.add("decision");
  if ((state.snapshot?.incidents ?? []).length) completed.add("runtime");
  if ((state.snapshot?.audit ?? []).length) completed.add("audit");
  document.querySelectorAll(".spine__station").forEach((station) => {
    station.classList.toggle(
      "is-complete",
      completed.has(station.dataset.stage),
    );
  });
}

function renderApprovalRoles(task, snapshot) {
  const select = byId("approval-role");
  const current = select.value;
  const taskRoles =
    task?.spec?.approvalRequirements?.flatMap((entry) => entry.roles ?? []) ??
    task?.spec?.approvals?.flatMap((entry) => entry.roles ?? []);
  const profileRoles = snapshot.profile?.policies?.requiredRoles?.candidate;
  const roles = [
    ...new Set(
      taskRoles?.length
        ? taskRoles
        : profileRoles?.length
          ? profileRoles
          : ["domain-steward"],
    ),
  ];
  select.replaceChildren(
    ...roles.map((role) => {
      const option = document.createElement("option");
      option.value = role;
      option.textContent = role;
      return option;
    }),
  );
  select.value = roles.includes(current) ? current : roles[0];
}

function renderRuntimeState(snapshot) {
  const observation = snapshot.observations?.at(-1);
  if (observation && !state.observationStoreId) {
    state.observationStoreId = observation.metadata?.id ?? null;
    if (state.observationStoreId) {
      byId("incident-observation-id").value = state.observationStoreId;
    }
  }
  const incident = snapshot.incidents?.at(-1);
  if (incident) {
    state.incidentId = incident.metadata?.id ?? state.incidentId;
    if (state.incidentId) byId("incident-id").value = state.incidentId;
    const severity =
      incident.metadata?.tags
        ?.find((entry) => entry.startsWith("severity:"))
        ?.slice("severity:".length) ?? "unassessed";
    byId("incident-result").textContent =
      `${incident.spec?.status ?? "unknown"} · severity ${severity} · ${(incident.spec?.observations ?? []).length} 条观察`;
  }
  const promotion = snapshot.promotions?.at(-1);
  if (promotion) {
    byId("promotion-result").textContent =
      `${promotion.metadata?.lifecycle ?? "candidate"} · ${promotion.spec?.candidateDigest ?? "—"} · 仍需人工 approval`;
  }
}

function render() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const counts = catalogCounts(snapshot);
  byId("profile-title").textContent = snapshot.profile?.title ?? "COGA Factory";
  byId("package-count").textContent = String(counts.packages);
  byId("artifact-count").textContent = String(counts.artifacts);
  byId("application-count").textContent = String(counts.applications);
  byId("task-count").textContent = String(snapshot.tasks.length);
  const task = state.activeTaskId ? taskFor(state.activeTaskId) : null;
  const run = state.activeTaskId ? runFor(state.activeTaskId) : null;
  renderApprovalRoles(task, snapshot);
  byId("active-task-label").textContent =
    task?.spec?.intent?.goal ?? "尚未创建任务";
  byId("active-run-state").textContent = run?.spec?.state ?? "—";
  byId("audit-state").textContent = snapshot.auditValid ? "完整" : "链校验失败";
  const deepseek = snapshot.adapters.find(
    (entry) => entry.runtime === "deepseek",
  );
  byId("model-state").textContent = deepseek?.available
    ? "DeepSeek 已注入"
    : "离线评估可用";
  byId("deepseek-assess-button").disabled =
    !deepseek?.available || !state.activeTaskId;
  const privateBinding = snapshot.applicationBindings?.[0];
  const privateFixtureButton = byId("load-private-observation-button");
  privateFixtureButton.disabled =
    !privateBinding || privateBinding.fixtures?.observations < 2;
  privateFixtureButton.textContent = privateBinding
    ? `载入 ${privateBinding.application.id} 事故 Fixture`
    : "未附加私有 Application binding";
  byId("offline-assess-button").disabled = !state.activeTaskId;
  byId("validator-button").disabled = !state.activeTaskId;
  byId("impact-button").disabled = !state.activeTaskId;
  byId("connection-lamp").classList.add("is-online");
  byId("connection-label").textContent = "本地已连接";
  renderQueue();
  renderDiff();
  renderProvenance();
  renderImpact();
  renderEvidence();
  renderRuntimeState(snapshot);
  renderAudit();
  renderSpine();
}

async function refresh({ preserveSelection = true } = {}) {
  const payload = await request("/api/bootstrap");
  state.token = payload.actionToken;
  state.snapshot = payload.snapshot;
  if (!preserveSelection || !taskFor(state.activeTaskId)) {
    state.activeTaskId = state.snapshot.tasks.at(-1)?.metadata?.id ?? null;
  }
  render();
}

function lines(value) {
  return value
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseJsonField(id) {
  try {
    return JSON.parse(byId(id).value);
  } catch (error) {
    throw new Error(
      `${byId(id).previousElementSibling?.textContent ?? id} 不是有效 JSON。`,
    );
  }
}

async function createIntent(event) {
  event.preventDefault();
  const intent = {
    mode: byId("intent-mode").value,
    goal: byId("intent-goal").value,
    acceptanceCriteria: lines(byId("intent-acceptance").value),
    nonGoals: lines(byId("intent-non-goals").value),
    risk: byId("intent-risk").value,
    sources: [
      {
        uri: byId("source-uri").value,
        sourceType: byId("source-type").value,
        authority: byId("source-authority").value,
        visibility: byId("source-visibility").value,
        excerpt: byId("source-excerpt").value,
      },
    ],
    candidate: {
      artifactId: byId("candidate-artifact-id").value,
      before: parseJsonField("candidate-before"),
      after: parseJsonField("candidate-after"),
    },
  };
  const payload = await request("/api/intents", {
    method: "POST",
    body: {
      intent,
      actor: {
        id: "human.local.operator",
        type: "human",
        roles: ["domain-steward"],
      },
    },
  });
  state.activeTaskId = payload.task.metadata.id;
  state.impact = null;
  await refresh();
  setPanel("candidate");
  showToast("候选任务已写入本地事实源。", false);
}

async function calculateImpact() {
  const candidate = candidateForTask(state.activeTaskId);
  if (!candidate) throw new Error("请先选择候选任务。");
  state.impact = await request(
    `/api/impact/${encodeURIComponent(candidate.artifactId)}`,
  );
  renderImpact();
  showToast("已生成确定性 Application 影响报告。", false);
}

async function assess(mode) {
  if (!state.activeTaskId) throw new Error("请先选择候选任务。");
  await request(`/api/tasks/${encodeURIComponent(state.activeTaskId)}/assess`, {
    method: "POST",
    body: { mode },
  });
  await refresh();
  setPanel("evidence");
  showToast(
    mode === "deepseek"
      ? "DeepSeek 评估已作为提案证据登记。"
      : "离线评估已登记。",
    false,
  );
}

async function validateTask() {
  if (!state.activeTaskId) throw new Error("请先选择候选任务。");
  await request(
    `/api/tasks/${encodeURIComponent(state.activeTaskId)}/validate`,
    {
      method: "POST",
      body: {},
    },
  );
  await refresh();
  showToast("白名单验证器执行完成，真实退出码与摘要已登记。", false);
}

async function decide(decision) {
  if (!state.activeTaskId) throw new Error("请先选择候选任务。");
  if (!state.impact) await calculateImpact();
  await request(
    `/api/tasks/${encodeURIComponent(state.activeTaskId)}/approve`,
    {
      method: "POST",
      body: {
        actor: {
          id: byId("approval-actor").value,
          type: "human",
          roles: [byId("approval-role").value],
        },
        roles: [byId("approval-role").value],
        decision,
        reason: byId("approval-reason").value,
      },
    },
  );
  await refresh();
  showToast(
    decision === "approve" ? "候选摘要已由人类批准。" : "候选已拒绝。",
    decision === "reject",
  );
}

async function preview() {
  if (!state.activeTaskId) throw new Error("请先选择候选任务。");
  const result = await request(
    `/api/tasks/${encodeURIComponent(state.activeTaskId)}/preview`,
    {
      method: "POST",
      body: {},
    },
  );
  const target = byId("preview-result");
  target.replaceChildren(
    text("span", result.status),
    text("strong", "RELEASE BLOCKED BY DESIGN"),
  );
  await refresh();
  showToast("本地预览决策已登记；生产发布仍被结构性阻断。", false);
}

function defaultObservation() {
  const time = new Date().toISOString();
  const id = `local-preview-error-${Date.now()}`;
  byId("observation-json").value = JSON.stringify(
    {
      specversion: "1.0",
      id,
      source: "urn:coga:application:aster-mini-program",
      type: "coga.application.preview.error",
      subject: "journey.open-briefing",
      time,
      datacontenttype: "application/json",
      data: {
        errorCode: "AUTH_SNAPSHOT_EXPIRED",
        journey: "open-briefing",
        count: 3,
      },
      coga: {
        application: { id: "application.aster.mini.program", version: "0.1.0" },
        scope: "application",
        classification: "internal",
        retentionDays: 30,
        schemaRef: "urn:coga:schema:preview-error:0.1.0",
        purpose: "Detect authorization snapshot failures during local preview.",
        owner: "example.application.aster",
      },
    },
    null,
    2,
  );
}

async function ingestObservation(event) {
  event.preventDefault();
  const result = await request("/api/observations", {
    method: "POST",
    body: {
      observation: parseJsonField("observation-json"),
      actor: { id: "human.local.operator", type: "human", roles: ["operator"] },
    },
  });
  state.observationStoreId = result.storeId;
  byId("incident-observation-id").value = result.storeId;
  await refresh();
  showToast("Application 观察已登记，仍保持 application scope。", false);
}

async function loadPrivateObservation() {
  const binding = state.snapshot?.applicationBindings?.[0];
  if (!binding) throw new Error("当前控制面未附加私有 Application binding。");
  const result = await request("/api/fixtures/load", {
    method: "POST",
    body: { bindingId: binding.id, type: "observation", index: 1 },
  });
  byId("observation-json").value = JSON.stringify(result.fixture, null, 2);
  showToast(
    "私有小程序事故 Fixture 已从 ignored overlay 载入；未复制到公开资产。",
    false,
  );
}

async function createIncident(event) {
  event.preventDefault();
  const id = byId("incident-id").value;
  const result = await request("/api/incidents", {
    method: "POST",
    body: {
      id,
      observationStoreIds: [byId("incident-observation-id").value],
      runbook: { id: byId("incident-runbook").value, version: "0.1.0" },
      actor: { id: "human.local.operator", type: "human", roles: ["operator"] },
    },
  });
  state.incidentId = result.id;
  byId("incident-result").textContent =
    `${result.state} · severity ${result.severity} · ${result.runbook.id}`;
  await refresh();
  showToast("事故已开启；严重级别仍等待人类判断。", false);
}

async function verifyIncident() {
  const id = state.incidentId ?? byId("incident-id").value;
  const result = await request(`/api/incidents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: {
      patch: {
        state: "verifying",
        severity: "sev3",
        diagnosis:
          "Authorization snapshot expiration reproduced in the local fixture.",
        repairCandidateDigest: "b".repeat(64),
        closure: {
          severityAssignedByHuman: true,
          criticalJourneyPassed: true,
          monitoringRecovered: true,
          regressionEvidenceDigest: "a".repeat(64),
          deploymentSucceeded: false,
        },
      },
      actor: {
        id: "human.incident.commander",
        type: "human",
        roles: ["incident-commander"],
      },
    },
  });
  byId("incident-result").textContent =
    `${result.state} · 用户旅程、监控和回归证据已登记`;
  await refresh();
  showToast("恢复条件已登记；部署成功没有被当作关闭条件。", false);
}

async function closeCurrentIncident() {
  const id = state.incidentId ?? byId("incident-id").value;
  const result = await request(`/api/incidents/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: {
      patch: { state: "closed" },
      actor: {
        id: "human.incident.commander",
        type: "human",
        roles: ["incident-commander"],
      },
    },
  });
  byId("incident-result").textContent =
    `${result.state} · ${result.observationIds.length} 条观察`;
  await refresh();
  showToast("事故已通过全部关闭条件。", false);
}

async function promote(event) {
  event.preventDefault();
  const incidentId = state.incidentId ?? byId("incident-id").value;
  const result = await request("/api/promotions", {
    method: "POST",
    body: {
      id: byId("promotion-id").value,
      incidentIds: [incidentId],
      targetPackage: { id: "broker.digital.channel.domain", version: "0.1.0" },
      candidateArtifact: {
        schemaVersion: "coga.dev/v0.1",
        kind: "DomainArtifact",
        metadata: {
          id: "broker.channel.authorization.snapshot.denial",
          title: "Authorization snapshot denial",
          version: "0.1.0",
          lifecycle: "candidate",
          scope: "instance",
          visibility: "public",
        },
        spec: {
          artifactType: "rule",
          summary:
            "Restricted capabilities default to deny when authorization evidence is stale or absent.",
        },
      },
      consumerApplications: [
        "application.aster.mini.program",
        "application.cedar.insight.h5",
      ],
      authoritativeSources: [byId("promotion-source").value],
      privateTermsScanPassed: true,
      independentScenarios: [byId("promotion-scenario").value],
      actor: {
        id: "human.domain.steward",
        type: "human",
        roles: ["domain-steward"],
      },
    },
  });
  byId("promotion-result").textContent =
    `${result.metadata.lifecycle} · ${result.spec.candidateDigest} · 仍需人工 approval`;
  await refresh();
  showToast("运行经验已形成共享候选，但没有自动发布。", false);
}

function guard(handler) {
  return async (event) => {
    try {
      await handler(event);
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), true);
    }
  };
}

document.querySelectorAll(".spine__station button").forEach((button) => {
  button.addEventListener("click", () =>
    setPanel(button.closest("li").dataset.panel),
  );
});
byId("task-queue").addEventListener("click", (event) => {
  const button = event.target.closest("[data-task-id]");
  if (!button) return;
  state.activeTaskId = button.dataset.taskId;
  state.impact = null;
  render();
  setPanel("candidate");
});
byId("intent-form").addEventListener("submit", guard(createIntent));
byId("impact-button").addEventListener("click", guard(calculateImpact));
byId("offline-assess-button").addEventListener(
  "click",
  guard(() => assess("offline")),
);
byId("deepseek-assess-button").addEventListener(
  "click",
  guard(() => assess("deepseek")),
);
byId("validator-button").addEventListener("click", guard(validateTask));
byId("approval-form").addEventListener(
  "submit",
  guard(async (event) => {
    event.preventDefault();
    await decide("approve");
  }),
);
byId("reject-button").addEventListener(
  "click",
  guard(() => decide("reject")),
);
byId("preview-button").addEventListener("click", guard(preview));
byId("observation-form").addEventListener("submit", guard(ingestObservation));
byId("load-private-observation-button").addEventListener(
  "click",
  guard(loadPrivateObservation),
);
byId("incident-form").addEventListener("submit", guard(createIncident));
byId("verify-incident-button").addEventListener("click", guard(verifyIncident));
byId("close-incident-button").addEventListener(
  "click",
  guard(closeCurrentIncident),
);
byId("promotion-form").addEventListener("submit", guard(promote));
byId("refresh-button").addEventListener(
  "click",
  guard(async () => {
    await refresh();
    showToast("已从文件事实源重新构建视图。", false);
  }),
);

defaultObservation();
refresh({ preserveSelection: false }).catch((error) => {
  byId("connection-label").textContent = "连接失败";
  showToast(error instanceof Error ? error.message : String(error), true);
});
