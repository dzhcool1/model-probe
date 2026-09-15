const STORAGE_KEYS = {
  profiles: "model-probe:profiles",
  runs: "model-probe:runs",
  catalogs: "model-probe:catalogs",
};

const MODEL_CATALOG_CACHE_MAX_AGE = 24 * 60 * 60 * 1000;

const state = {
  protocol: "openai",
  models: [],
  results: new Map(),
  profiles: [],
  runs: [],
  catalogCache: {},
  catalogSource: "",
  catalogFetchedAt: null,
  modelQuery: "",
  modelStatusFilter: "all",
  resultSort: "catalog",
  selected: new Set(),
  batch: [],
  batchScope: "",
  running: false,
  stopRequested: false,
  expanded: new Set(),
  activeProfileId: "",
  activeRunId: "",
  startedAt: null,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const elements = {
  profileSelect: $("#profileSelect"),
  profileName: $("#profileName"),
  saveProfile: $("#saveProfile"),
  deleteProfile: $("#deleteProfile"),
  importCcSwitch: $("#importCcSwitch"),
  baseUrl: $("#baseUrl"),
  apiKey: $("#apiKey"),
  prompt: $("#prompt"),
  maxTokens: $("#maxTokens"),
  concurrency: $("#concurrency"),
  timeoutSeconds: $("#timeoutSeconds"),
  cacheProbe: $("#cacheProbe"),
  runAll: $("#runAll"),
  runSelected: $("#runSelected"),
  runSelectedLabel: $("#runSelectedLabel"),
  selectedCount: $("#selectedCount"),
  selectAllModels: $("#selectAllModels"),
  selectVisibleModels: $("#selectVisibleModels"),
  invertSelection: $("#invertSelection"),
  clearSelection: $("#clearSelection"),
  loadModels: $("#loadModels"),
  stopProbe: $("#stopProbe"),
  modelList: $("#modelList"),
  modelCount: $("#modelCount"),
  modelCountNote: $("#modelCountNote"),
  completedCount: $("#completedCount"),
  successRate: $("#successRate"),
  medianLatency: $("#medianLatency"),
  p95Latency: $("#p95Latency"),
  fastestTtft: $("#fastestTtft"),
  averageSpeed: $("#averageSpeed"),
  cacheHitCount: $("#cacheHitCount"),
  cacheCoverage: $("#cacheCoverage"),
  latencyChart: $("#latencyChart"),
  timingChart: $("#timingChart"),
  cacheDonut: $("#cacheDonut"),
  cacheLegend: $("#cacheLegend"),
  cacheChartNote: $("#cacheChartNote"),
  catalogNote: $("#catalogNote"),
  catalogVisibleNote: $("#catalogVisibleNote"),
  modelSearch: $("#modelSearch"),
  modelStatusFilter: $("#modelStatusFilter"),
  resultSort: $("#resultSort"),
  retryFailed: $("#retryFailed"),
  resultsCount: $("#resultsCount"),
  tokenUsage: $("#tokenUsage"),
  tokenCoverage: $("#tokenCoverage"),
  runInsight: $("#runInsight"),
  cacheInsight: $("#cacheInsight"),
  exportJson: $("#exportJson"),
  exportCsv: $("#exportCsv"),
  connectionSummary: $("#connectionSummary"),
  connectionStatus: $("#connectionStatus"),
  runStatus: $("#runStatus"),
  lastRunAt: $("#lastRunAt"),
  progressLabel: $("#progressLabel"),
  progressValue: $("#progressValue"),
  progressBar: $("#progressBar"),
  resultsBody: $("#resultsBody"),
  globalError: $("#globalError"),
  toggleKey: $("#toggleKey"),
  historyButton: $("#historyButton"),
  historyDialog: $("#historyDialog"),
  closeHistory: $("#closeHistory"),
  clearHistory: $("#clearHistory"),
  historyList: $("#historyList"),
};

const protocolLabels = {
  auto: "自动识别",
  openai: "OpenAI",
  google: "Google",
  claude: "Claude",
};

const statusLabels = {
  waiting: "待测",
  running: "检测中",
  success: "成功",
  error: "失败",
  skipped: "跳过",
};

const cacheLabels = {
  hit: "命中",
  write: "写入",
  miss: "未命中",
  unknown: "未知",
};

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeId(prefix) {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function readStorage(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "null");
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    showError("浏览器拒绝了本地保存，请检查隐私或存储设置。");
  }
}

function formatMs(value) {
  if (value === null || value === undefined || value === "") return "—";
  return Number.isFinite(Number(value)) ? Math.round(Number(value)) + " ms" : "—";
}

function compactMs(value) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number >= 1000 ? (number / 1000).toFixed(1) + " s" : Math.round(number) + " ms";
}

function formatNumber(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "—";
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() + suffix : "—";
}

function numericValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function protocolName(protocol = state.protocol) {
  return protocolLabels[protocol] || String(protocol || "").toUpperCase();
}

function setStatus(message, type = "") {
  elements.runStatus.textContent = message;
  elements.runStatus.className = "run-status " + type;
}

function showError(message) {
  elements.globalError.hidden = !message;
  elements.globalError.textContent = message || "";
}

function setConnectionStatus(message, type = "idle") {
  elements.connectionStatus.textContent = message;
  elements.connectionStatus.className = "connection-status " + type;
}

function updateConnectionSummary() {
  const base = elements.baseUrl.value.trim();
  elements.connectionSummary.textContent = base ? protocolName() + "  ·  " + base : "等待一组连接";
}

function updateProtocol(protocol) {
  state.protocol = protocol;
  $$("[data-protocol]").forEach((button) => {
    button.classList.toggle("active", button.dataset.protocol === protocol);
  });
  if (protocol === "auto") {
    elements.baseUrl.placeholder = "输入地址，自动识别 OpenAI / Google / Claude";
    $("#urlHint").textContent = "会按 OpenAI、Google、Claude 顺序尝试模型列表接口";
  } else if (protocol === "google") {
    elements.baseUrl.placeholder = "https://generativelanguage.googleapis.com/v1beta";
    $("#urlHint").textContent = "Google 原生 Generative Language API 地址";
  } else if (protocol === "claude") {
    elements.baseUrl.placeholder = "https://api.anthropic.com/v1";
    $("#urlHint").textContent = "Claude 原生 Messages API 地址";
  } else {
    elements.baseUrl.placeholder = "https://api.openai.com/v1";
    $("#urlHint").textContent = "支持根地址、/v1 或完整模型接口地址";
  }
  updateConnectionSummary();
}

function formValues() {
  return {
    protocol: state.protocol,
    baseUrl: elements.baseUrl.value.trim(),
    apiKey: elements.apiKey.value,
    prompt: elements.prompt.value,
    maxTokens: Number(elements.maxTokens.value) || 16,
    concurrency: Number(elements.concurrency.value) || 3,
    timeoutSeconds: Math.min(180, Math.max(10, Number(elements.timeoutSeconds.value) || 90)),
    cacheProbe: elements.cacheProbe.checked,
  };
}

function validateConnection(values = formValues()) {
  if (!values.baseUrl) {
    showError("请先填写 Base URL。");
    elements.baseUrl.focus();
    return false;
  }
  if (!values.apiKey.trim()) {
    showError("请先填写 API Key。");
    elements.apiKey.focus();
    return false;
  }
  if (!values.prompt.trim()) {
    showError("测试提示词不能为空。");
    elements.prompt.focus();
    return false;
  }
  return true;
}

function setBusy(busy) {
  elements.loadModels.disabled = busy;
  elements.saveProfile.disabled = busy;
  elements.importCcSwitch.disabled = busy;
  elements.profileSelect.disabled = busy;
  elements.deleteProfile.disabled = busy || !state.activeProfileId;
  elements.stopProbe.disabled = !busy;
  renderSelectionTools();
}

function renderSelectionTools() {
  const busy = state.running;
  const hasModels = state.models.length > 0;
  const count = state.selected.size;
  elements.selectedCount.textContent = count ? "已选中 " + count + " 个" : "未选中";
  elements.runSelectedLabel.textContent = count ? "测试选中 " + count : "测试选中";
  elements.runSelected.disabled = busy || !count;
  elements.runAll.disabled = busy || !hasModels;
  elements.selectAllModels.disabled = busy || !hasModels;
  elements.selectVisibleModels.disabled = busy || !hasModels;
  elements.invertSelection.disabled = busy || !hasModels;
  elements.clearSelection.disabled = busy || !count;
}

function renderProfiles() {
  const selected = state.activeProfileId;
  const options = ['<option value="">当前未保存</option>'];
  state.profiles.forEach((profile) => {
    options.push('<option value="' + escapeHtml(profile.id) + '"' + (profile.id === selected ? " selected" : "") + ">" + escapeHtml(profile.name) + " · " + escapeHtml(protocolName(profile.protocol)) + "</option>");
  });
  elements.profileSelect.innerHTML = options.join("");
  elements.deleteProfile.hidden = !state.activeProfileId;
}

function resetDashboard() {
  state.models = [];
  state.results.clear();
  state.expanded.clear();
  state.activeRunId = "";
  state.catalogSource = "";
  state.catalogFetchedAt = null;
  state.modelQuery = "";
  state.modelStatusFilter = "all";
  state.resultSort = "catalog";
  state.selected.clear();
  state.batch = [];
  state.batchScope = "";
  elements.modelSearch.value = "";
  elements.modelStatusFilter.value = "all";
  elements.resultSort.value = "catalog";
  renderDashboard();
  elements.lastRunAt.textContent = "尚无运行记录";
  elements.progressLabel.textContent = "先获取模型目录";
  elements.progressValue.textContent = "0%";
  elements.progressBar.style.width = "0%";
}

function loadProfile(profileId) {
  const profile = state.profiles.find((item) => item.id === profileId);
  if (!profile) {
    state.activeProfileId = "";
    elements.profileName.value = "";
    renderProfiles();
    setConnectionStatus("未保存", "idle");
    return;
  }
  state.activeProfileId = profile.id;
  elements.profileName.value = profile.name;
  elements.baseUrl.value = profile.baseUrl || "";
  elements.apiKey.value = profile.apiKey || "";
  elements.prompt.value = profile.prompt || "Reply with a short acknowledgement.";
  elements.maxTokens.value = profile.maxTokens || 16;
  elements.concurrency.value = profile.concurrency || 3;
  elements.timeoutSeconds.value = profile.timeoutSeconds || 90;
  elements.cacheProbe.checked = profile.cacheProbe !== false;
  updateProtocol(profile.protocol || "openai");
  renderProfiles();
  resetDashboard();
  setConnectionStatus("已保存", "ready");
  setStatus("已载入配置", "success");
  showError("");
}

function createNewProfile() {
  state.activeProfileId = "";
  elements.profileName.value = "";
  renderProfiles();
  resetDashboard();
  setConnectionStatus("未保存", "idle");
  setStatus("等待连接", "");
  showError("");
}

function saveProfile() {
  const values = formValues();
  if (!values.baseUrl) {
    showError("至少填写 Base URL 后才能保存配置。");
    elements.baseUrl.focus();
    return;
  }
  const name = elements.profileName.value.trim() || (protocolName() + " 连接");
  const existing = state.profiles.find((profile) => profile.id === state.activeProfileId);
  const profile = {
    ...(existing || {}),
    id: existing?.id || makeId("profile"),
    name,
    ...values,
    updatedAt: Date.now(),
  };
  state.profiles = [profile].concat(state.profiles.filter((item) => item.id !== profile.id));
  state.activeProfileId = profile.id;
  writeStorage(STORAGE_KEYS.profiles, state.profiles);
  renderProfiles();
  setConnectionStatus("已保存", "ready");
  setStatus("配置已保存", "success");
  showError("");
}

function deleteProfile() {
  const profile = state.profiles.find((item) => item.id === state.activeProfileId);
  if (!profile || !window.confirm("确定删除“" + profile.name + "”吗？")) return;
  state.profiles = state.profiles.filter((item) => item.id !== profile.id);
  writeStorage(STORAGE_KEYS.profiles, state.profiles);
  createNewProfile();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ("请求失败（HTTP " + response.status + "）"));
  return data;
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || ("请求失败（HTTP " + response.status + "）"));
  return data;
}

function catalogCacheKey(values) {
  const source = [values.protocol, values.baseUrl, values.apiKey].join("\u0000");
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return "catalog-" + (hash >>> 0).toString(36);
}

function saveCatalogCache(values, response) {
  const fetchedAt = Date.now();
  const protocols = new Set([values.protocol, response.protocol]);
  protocols.forEach((protocol) => {
    if (!protocol || (protocol === "auto" && !response.protocol)) return;
    state.catalogCache[catalogCacheKey({ ...values, protocol })] = {
      protocol: response.protocol || protocol,
      baseUrl: response.baseUrl || values.baseUrl,
      models: response.models || [],
      fetchedAt,
    };
  });
  state.catalogCache = Object.fromEntries(
    Object.entries(state.catalogCache)
      .sort(([, first], [, second]) => Number(first.fetchedAt || 0) - Number(second.fetchedAt || 0))
      .slice(-30),
  );
  writeStorage(STORAGE_KEYS.catalogs, state.catalogCache);
  return fetchedAt;
}

function cachedCatalog(values) {
  const cached = state.catalogCache[catalogCacheKey(values)];
  if (!cached || !Array.isArray(cached.models) || !cached.models.length || !cached.fetchedAt) return null;
  if (Date.now() - Number(cached.fetchedAt) > MODEL_CATALOG_CACHE_MAX_AGE) return null;
  return cached;
}

async function importCcSwitchProfiles() {
  if (state.running) return;
  state.running = true;
  setBusy(true);
  showError("");
  setStatus("正在读取 CC Switch 配置...", "running");
  try {
    const response = await getJson("/api/ccswitch/profiles");
    const imported = Array.isArray(response.profiles) ? response.profiles : [];
    const importedIds = new Set(imported.map((profile) => profile.id));
    const existingById = new Map(state.profiles.map((profile) => [profile.id, profile]));
    const importedAt = Date.now();
    imported.forEach((profile) => {
      existingById.set(profile.id, {
        ...(existingById.get(profile.id) || {}),
        ...profile,
        importedAt,
        updatedAt: importedAt,
      });
    });
    state.profiles = imported.concat(
      state.profiles.filter((profile) => !importedIds.has(profile.id)),
    ).map((profile) => existingById.get(profile.id) || profile);
    writeStorage(STORAGE_KEYS.profiles, state.profiles);
    renderProfiles();

    const selected = imported.find((profile) => profile.sourceAppType === "codex" && profile.isCurrent)
      || imported.find((profile) => profile.isCurrent)
      || imported[0];
    if (selected) {
      loadProfile(selected.id);
      setStatus("已导入 " + imported.length + " 个配置", "success");
    } else {
      setStatus("没有找到可导入的 CC Switch 配置", "");
    }
    if (response.skipped) {
      elements.progressLabel.textContent = "已跳过 " + response.skipped + " 个无完整地址或 Key 的配置";
    }
  } catch (error) {
    setStatus("CC Switch 导入失败", "error");
    showError(error.message);
  } finally {
    state.running = false;
    setBusy(false);
    elements.stopProbe.disabled = true;
  }
}

async function discoverModels() {
  const values = formValues();
  try {
    const response = await postJson("/api/models", {
      protocol: values.protocol,
      baseUrl: values.baseUrl,
      apiKey: values.apiKey,
    });
    const actualProtocol = response.protocol || values.protocol;
    if (actualProtocol !== values.protocol) updateProtocol(actualProtocol);
    state.models = response.models || [];
    state.results.clear();
    state.expanded.clear();
    state.selected.clear();
    state.batch = [];
    state.batchScope = "";
    state.activeRunId = "";
    state.catalogSource = values.protocol === "auto" ? "auto" : "live";
    state.catalogFetchedAt = state.models.length ? saveCatalogCache(values, response) : null;
    renderDashboard();
    setConnectionStatus(values.protocol === "auto" ? "已识别" : "已连接", "ready");
    return state.models;
  } catch (error) {
    const cached = cachedCatalog(values);
    if (!cached) throw error;
    updateProtocol(cached.protocol || values.protocol);
    state.models = cached.models;
    state.results.clear();
    state.expanded.clear();
    state.selected.clear();
    state.batch = [];
    state.batchScope = "";
    state.activeRunId = "";
    state.catalogSource = "cache";
    state.catalogFetchedAt = cached.fetchedAt;
    renderDashboard();
    setConnectionStatus("使用缓存", "ready");
    setStatus("模型列表暂不可用，已载入 " + state.models.length + " 个缓存模型", "");
    return state.models;
  }
}

async function loadModels() {
  if (state.running) return;
  const values = formValues();
  if (!validateConnection(values)) return;
  state.running = true;
  setBusy(true);
  elements.stopProbe.disabled = true;
  showError("");
  setStatus("正在获取模型目录...", "running");
  try {
    const models = await discoverModels();
    const message = state.catalogSource === "cache"
      ? "已载入 " + models.length + " 个缓存模型"
      : state.catalogSource === "auto"
        ? "已识别为 " + protocolName() + " · 获取 " + models.length + " 个模型"
        : "已获取 " + models.length + " 个模型";
    setStatus(message, state.catalogSource === "cache" ? "" : "success");
    elements.progressLabel.textContent = models.length
      ? "模型目录已就绪 · 可勾选模型后单独测试"
      : "接口没有返回模型";
    elements.progressValue.textContent = "0%";
    elements.progressBar.style.width = "0%";
  } catch (error) {
    state.models = [];
    state.results.clear();
    renderDashboard();
    setConnectionStatus("连接失败", "error");
    setStatus("模型获取失败", "error");
    showError(error.message);
  } finally {
    state.running = false;
    setBusy(false);
    elements.stopProbe.disabled = true;
  }
}

function successfulEntries() {
  return [...state.results.entries()]
    .filter(([, result]) => result.status === "success" && result.data)
    .map(([model, result]) => ({ model, data: result.data }));
}

function finishedCount() {
  return [...state.results.values()].filter((result) => ["success", "error", "skipped"].includes(result.status)).length;
}

function batchSnapshot() {
  const batch = state.batch;
  const finished = batch.filter((id) => {
    const status = state.results.get(id)?.status;
    return status === "success" || status === "error" || status === "skipped";
  }).length;
  return { total: batch.length, finished };
}

function updateProgress() {
  const catalogTotal = state.models.length;
  const { total, finished } = batchSnapshot();
  const percent = total ? Math.round(finished / total * 100) : 0;
  elements.progressValue.textContent = percent + "%";
  elements.progressBar.style.width = percent + "%";
  const scopeLabel = state.batchScope === "selected"
    ? "选中测试"
    : state.batchScope === "failed"
      ? "失败项重试"
      : state.batchScope === "retest"
        ? "单模型复测"
        : "全量测试";
  if (!catalogTotal) {
    if (!state.running) elements.progressLabel.textContent = "先获取模型目录";
    return;
  }
  if (!total) {
    if (!state.running) elements.progressLabel.textContent = "模型目录已就绪 · 可勾选模型后单独测试";
    return;
  }
  if (state.running) {
    elements.progressLabel.textContent = scopeLabel + "进行中 · " + finished + " / " + total + " 个模型";
  } else if (finished === total) {
    elements.progressLabel.textContent = scopeLabel + "完成 · " + total + " 个模型";
  } else {
    elements.progressLabel.textContent = scopeLabel + "已停止 · " + finished + " / " + total + " 个模型";
  }
}

function updateSummary() {
  const total = state.models.length;
  const entries = successfulEntries();
  const finished = finishedCount();
  const attempted = state.models.filter((model) => model.probeable !== false).length;
  const latencies = entries.map(({ data }) => numericValue(data.latencyMs)).filter((value) => value !== null).sort((a, b) => a - b);
  const ttfts = entries.map(({ data }) => numericValue(data.ttftMs)).filter((value) => value !== null);
  const caches = entries.map(({ data }) => data.cache?.status || "unknown");
  const observedCaches = entries.filter(({ data }) => data.cache?.fieldsObserved).length;
  const hits = caches.filter((status) => status === "hit").length;
  const median = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  const speeds = entries.map(({ data }) => numericValue(data.tokensPerSecond)).filter((value) => value !== null);
  const averageSpeed = speeds.length ? speeds.reduce((total, value) => total + value, 0) / speeds.length : null;
  const inputTokens = entries.reduce((total, { data }) => total + (numericValue(data.first?.usage?.inputTokens) ?? numericValue(data.second?.usage?.inputTokens) ?? 0), 0);
  const outputTokens = entries.reduce((total, { data }) => total + (numericValue(data.outputTokens) ?? numericValue(data.first?.usage?.outputTokens) ?? 0), 0);
  const tokenSamples = entries.filter(({ data }) => numericValue(data.first?.usage?.inputTokens) !== null || numericValue(data.outputTokens) !== null).length;
  const failed = [...state.results.values()].filter((result) => result.status === "error").length;
  const fastest = entries
    .filter(({ data }) => numericValue(data.latencyMs) !== null)
    .sort((a, b) => Number(a.data.latencyMs) - Number(b.data.latencyMs))[0];
  const cacheCounts = caches.reduce((counts, status) => {
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});

  elements.modelCount.textContent = String(total);
  elements.modelCountNote.textContent = total ? attempted + " 个可探测" : "等待获取模型";
  elements.completedCount.textContent = finished + " / " + total;
  const attemptedResults = [...state.results.values()].filter((result) => result.status === "success" || result.status === "error").length;
  elements.successRate.textContent = attemptedResults ? "成功率 " + Math.round(entries.length / attemptedResults * 100) + "%" : "成功率 —";
  elements.medianLatency.textContent = compactMs(median);
  elements.p95Latency.textContent = compactMs(p95);
  elements.fastestTtft.textContent = "最快 TTFT " + compactMs(ttfts.length ? Math.min(...ttfts) : null);
  elements.averageSpeed.textContent = "平均速度 " + (averageSpeed === null ? "—" : averageSpeed.toFixed(1) + " tok/s");
  elements.cacheHitCount.textContent = entries.length ? String(hits) : "—";
  elements.cacheCoverage.textContent = entries.length ? "已返回字段 " + observedCaches + " / " + entries.length : "等待 usage 信号";
  const totalTokens = inputTokens + outputTokens;
  elements.tokenUsage.textContent = tokenSamples ? formatNumber(totalTokens) : "—";
  elements.tokenCoverage.textContent = tokenSamples ? inputTokens.toLocaleString() + " in · " + outputTokens.toLocaleString() + " out" : "等待 usage 信号";

  if (!total) {
    elements.runInsight.textContent = "运行完成后，这里会给出最快模型、失败项和缓存信号摘要。";
    elements.cacheInsight.textContent = "缓存状态等待探测";
  } else if (!entries.length) {
    elements.runInsight.textContent = finished ? "当前没有成功响应，请打开结果详情查看上游错误。" : "模型目录已就绪，等待探测结果。";
    elements.cacheInsight.textContent = "暂无可分析的缓存 usage";
  } else {
    const fastestText = fastest ? "最快 " + fastest.model + " · " + compactMs(fastest.data.latencyMs) : "暂无延迟数据";
    elements.runInsight.textContent = fastestText + "；" + (failed ? failed + " 个模型失败" : "没有失败模型");
    if (!observedCaches) {
      elements.cacheInsight.textContent = "上游未返回缓存字段，当前 " + entries.length + " 个成功结果均为未知";
    } else {
      const signalCount = (cacheCounts.hit || 0) + (cacheCounts.write || 0) + (cacheCounts.miss || 0);
      elements.cacheInsight.textContent = "已观察 " + signalCount + " / " + entries.length + " 个缓存信号 · 命中 " + hits;
    }
  }
}

function modelState(model) {
  const result = state.results.get(model.id);
  return result?.status || "waiting";
}

function visibleModels(candidates = state.models) {
  const query = state.modelQuery.trim().toLowerCase();
  return candidates.filter((model) => {
    const matchesQuery = !query || model.id.toLowerCase().includes(query);
    const matchesStatus = state.modelStatusFilter === "all" || modelState(model) === state.modelStatusFilter;
    return matchesQuery && matchesStatus;
  });
}

function sortedModels(models) {
  const sorted = [...models];
  const metric = (model, key) => numericValue(state.results.get(model.id)?.data?.[key]);
  if (state.resultSort === "name") return sorted.sort((a, b) => a.id.localeCompare(b.id));
  if (state.resultSort === "latency") return sorted.sort((a, b) => (metric(a, "latencyMs") ?? Infinity) - (metric(b, "latencyMs") ?? Infinity));
  if (state.resultSort === "ttft") return sorted.sort((a, b) => (metric(a, "ttftMs") ?? Infinity) - (metric(b, "ttftMs") ?? Infinity));
  if (state.resultSort === "speed") return sorted.sort((a, b) => (metric(b, "tokensPerSecond") ?? -Infinity) - (metric(a, "tokensPerSecond") ?? -Infinity));
  return sorted;
}

function percentile(values, ratio) {
  if (!values.length) return null;
  const index = (values.length - 1) * ratio;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return values[lower];
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

function renderModelList() {
  if (!state.models.length) {
    elements.catalogNote.textContent = "尚未获取";
    elements.catalogVisibleNote.textContent = "";
    elements.modelList.className = "model-list empty-state";
    elements.modelList.innerHTML = '<div class="empty-icon" aria-hidden="true">⌁</div><strong>还没有模型目录</strong><span>获取模型后可搜索、筛选和勾选</span>';
    return;
  }
  const probeable = state.models.filter((model) => model.probeable !== false).length;
  const source = state.catalogSource === "cache"
    ? "目录缓存 · " + formatDate(state.catalogFetchedAt)
    : state.catalogSource === "auto"
      ? "自动识别 · " + protocolName()
      : "实时目录";
  elements.catalogNote.textContent = state.models.length + " 个模型 · " + probeable + " 个可探测 · " + source;
  const models = visibleModels();
  elements.catalogVisibleNote.textContent = models.length === state.models.length ? "" : "显示 " + models.length + " 个";
  if (!models.length) {
    elements.modelList.className = "model-list empty-state";
    elements.modelList.innerHTML = '<div class="empty-icon" aria-hidden="true">⌕</div><strong>没有符合条件的模型</strong><span>调整搜索关键词或状态筛选</span>';
    return;
  }
  elements.modelList.className = "model-list";
  elements.modelList.innerHTML = models.map((model) => {
    const status = modelState(model);
    const selected = state.selected.has(model.id);
    const probeable = model.probeable !== false;
    const label = status === "waiting" ? "待测" : (statusLabels[status] || status);
    return '<label class="model-option' + (selected ? " is-selected" : "") + (probeable ? "" : " is-unprobeable") + ' state-' + status + '" title="' + escapeHtml(model.id) + '">' +
      '<input type="checkbox" class="model-check" data-model-id="' + escapeHtml(model.id) + '"' +
      (selected ? " checked" : "") + (probeable ? "" : " disabled") + " />" +
      '<span class="model-state-dot"></span>' +
      '<span class="model-option-name">' + escapeHtml(model.label) + "</span>" +
      '<span class="model-option-status">' + label + "</span>" +
      "</label>";
  }).join("");
  $$(".model-check").forEach((input) => input.addEventListener("change", () => {
    toggleModelSelection(input.dataset.modelId, input.checked);
  }));
}

function toggleModelSelection(modelId, checked) {
  if (state.running) return;
  const model = state.models.find((item) => item.id === modelId);
  if (!model || model.probeable === false) return;
  if (checked) state.selected.add(modelId);
  else state.selected.delete(modelId);
  renderSelectionTools();
  const card = $(`.model-check[data-model-id="${CSS.escape(modelId)}"]`)?.closest(".model-option");
  if (card) card.classList.toggle("is-selected", checked);
}

function cacheLabel(cache) {
  const status = cache?.status || "unknown";
  const read = Number(cache?.readTokens);
  const write = Number(cache?.writeTokens);
  const token = Number.isFinite(read) && read > 0
    ? "读 " + formatNumber(read)
    : Number.isFinite(write) && write > 0
      ? "写 " + formatNumber(write)
      : "";
  return '<div class="cache-cell"><span class="cache-label ' + status + '">' + (cacheLabels[status] || "未知") + "</span>" +
    (token ? '<span class="sub-metric">' + token + "</span>" : "") + "</div>";
}

function resultRow(model, result) {
  const status = result?.status || "waiting";
  const label = statusLabels[status] || status;
  const data = result?.data;
  const success = status === "success" && data;
  const detailsOpen = state.expanded.has(model);
  const second = data?.second;
  const usage = data?.first?.usage;
  const detailText = success
    ? "首次 " + formatMs(data.first?.totalMs) + " · usage " + (usage?.inputTokens ?? "—") + " in / " + (usage?.outputTokens ?? "—") + " out" +
      (data.cache?.source ? " · " + data.cache.source : "")
    : (result?.error || (status === "skipped" ? "上游标记为不可生成模型。" : ""));
  const outputPreview = success && data.first?.outputPreview ? data.first.outputPreview : "";
  const actionLabel = status === "error" ? "重试" : status === "success" ? "复测" : "测试";
  const actionDisabled = state.running || status === "running";
  return "<tr>" +
    '<td class="model-cell" title="' + escapeHtml(model) + '">' + escapeHtml(model) + "</td>" +
    '<td><span class="status-label ' + status + '">' + label + "</span></td>" +
    '<td class="metric">' + (success ? formatMs(data.latencyMs) : "—") + "</td>" +
    '<td class="metric">' + (success ? formatMs(data.ttftMs) : "—") + "</td>" +
    '<td class="metric">' + (success ? formatNumber(data.tokensPerSecond) : "—") + "</td>" +
    "<td>" + (success ? cacheLabel(data.cache) : "—") + "</td>" +
    '<td class="metric">' + (second ? formatMs(second.totalMs) : "—") + "</td>" +
    '<td><div class="row-actions"><button type="button" class="detail-button" data-detail-model="' + escapeHtml(model) + '">' + (detailsOpen ? "收起" : "详情") + "</button>" +
      '<button type="button" class="retest-button" data-retest-model="' + escapeHtml(model) + '"' + (actionDisabled ? " disabled" : "") + ">" + actionLabel + "</button></div></td>" +
    "</tr>" +
    (detailsOpen ? '<tr class="detail-row"><td colspan="8"><div class="detail-box">' + escapeHtml(detailText) +
      (success && data.cache?.fieldsObserved === false ? "<br>上游没有返回可确认缓存状态的字段" : "") +
      (outputPreview ? "<code>" + escapeHtml(outputPreview) + "</code>" : "") +
      "</div></td></tr>" : "");
}

function renderResults() {
  const tested = state.models.filter((model) => state.results.has(model.id));
  if (!state.models.length || !tested.length) {
    elements.resultsCount.textContent = state.models.length ? "等待测试" : "尚未测试";
    elements.retryFailed.disabled = true;
    elements.resultsBody.innerHTML = '<tr><td colspan="8" class="table-empty">测试后显示结果</td></tr>';
    return;
  }
  const models = sortedModels(visibleModels(tested));
  const failed = tested.filter((model) => state.results.get(model.id)?.status === "error");
  const finished = finishedCount();
  elements.resultsCount.textContent = "完成 " + finished + " / " + tested.length + " 个已测" + (models.length === tested.length ? "" : " · 显示 " + models.length);
  elements.retryFailed.disabled = state.running || !failed.length;
  elements.retryFailed.innerHTML = '<span aria-hidden="true">↻</span>' + (failed.length ? "重试失败项 " + failed.length : "重试失败项");
  if (!models.length) {
    elements.resultsBody.innerHTML = '<tr><td colspan="8" class="table-empty">没有符合当前筛选条件的结果</td></tr>';
    return;
  }
  elements.resultsBody.innerHTML = models
    .map((model) => resultRow(model.id, state.results.get(model.id)))
    .join("");
  $$("[data-detail-model]").forEach((button) => button.addEventListener("click", () => {
    const model = button.dataset.detailModel;
    if (state.expanded.has(model)) state.expanded.delete(model);
    else state.expanded.add(model);
    renderResults();
  }));
  $$("[data-retest-model]").forEach((button) => button.addEventListener("click", () => probeModels([button.dataset.retestModel], "retest")));
}

function renderLatencyChart() {
  const entries = successfulEntries().sort((a, b) => Number(a.data.latencyMs) - Number(b.data.latencyMs));
  if (!entries.length) {
    elements.latencyChart.className = "bar-chart empty-chart";
    elements.latencyChart.innerHTML = "<span>完成探测后显示延迟排行</span>";
    return;
  }
  const max = Math.max(...entries.map(({ data }) => numericValue(data.latencyMs)).filter((value) => value !== null), 1);
  elements.latencyChart.className = "bar-chart";
  elements.latencyChart.innerHTML = entries.map(({ model, data }) => {
    const value = numericValue(data.latencyMs);
    const width = Math.max(4, value / max * 100);
    return '<div class="bar-row" title="' + escapeHtml(model) + " · " + formatMs(value) + '">' +
      '<span class="bar-label">' + escapeHtml(model) + "</span>" +
      '<span class="bar-track"><span class="bar-fill" style="width:' + width + '%"></span></span>' +
      '<strong class="bar-value">' + compactMs(value) + "</strong></div>";
  }).join("");
}

function renderTimingChart() {
  const entries = successfulEntries()
    .filter(({ data }) => numericValue(data.first?.totalMs) !== null)
    .sort((a, b) => numericValue(b.data.first?.totalMs) - numericValue(a.data.first?.totalMs));
  if (!entries.length) {
    elements.timingChart.className = "timing-chart empty-chart";
    elements.timingChart.innerHTML = "<span>完成探测后显示时间构成</span>";
    return;
  }
  const max = Math.max(...entries.map(({ data }) => numericValue(data.first?.totalMs)).filter((value) => value !== null), 1);
  elements.timingChart.className = "timing-chart";
  elements.timingChart.innerHTML = entries.map(({ model, data }) => {
    const total = numericValue(data.first?.totalMs);
    const ttft = numericValue(data.first?.ttftMs);
    const totalWidth = Math.max(4, total / max * 100);
    const ttftWidth = ttft !== null ? Math.min(100, Math.max(0, ttft / total * 100)) : 0;
    return '<div class="timing-row" title="' + escapeHtml(model) + " · TTFT " + formatMs(ttft) + " · 总计 " + formatMs(total) + '">' +
      '<span class="bar-label">' + escapeHtml(model) + "</span>" +
      '<span class="timing-track"><span class="timing-total" style="width:' + totalWidth + '%"><span class="timing-ttft" style="width:' + ttftWidth + '%"></span></span></span>' +
      '<strong class="bar-value">' + compactMs(ttft) + " / " + compactMs(total) + "</strong></div>";
  }).join("");
}

function renderCacheChart() {
  const entries = successfulEntries();
  if (!entries.length) {
    elements.cacheDonut.className = "cache-donut empty-donut";
    elements.cacheDonut.style.background = "";
    elements.cacheDonut.innerHTML = "<span>—</span>";
    elements.cacheLegend.innerHTML = '<span class="legend-empty">完成探测后显示缓存信号</span>';
    elements.cacheChartNote.textContent = "缓存状态取自上游 usage 字段。";
    return;
  }
  const counts = { hit: 0, write: 0, miss: 0, unknown: 0 };
  entries.forEach(({ data }) => {
    const status = cacheLabels[data.cache?.status] ? data.cache.status : "unknown";
    counts[status] += 1;
  });
  const colors = { hit: "#159f91", write: "#d88935", miss: "#edaa4d", unknown: "#9aa8b0" };
  const segments = [];
  let start = 0;
  const total = entries.length;
  Object.entries(counts).forEach(([status, count]) => {
    if (!count) return;
    const end = start + count / total * 360;
    segments.push(colors[status] + " " + start + "deg " + end + "deg");
    start = end;
  });
  elements.cacheDonut.className = "cache-donut";
  elements.cacheDonut.style.background = "conic-gradient(" + segments.join(", ") + ")";
  const observed = counts.hit + counts.write + counts.miss;
  elements.cacheDonut.innerHTML = observed
    ? "<strong>" + counts.hit + "</strong><span>命中</span>"
    : "<strong>未知</strong><span>未返回</span>";
  elements.cacheLegend.innerHTML = Object.entries(counts).map(([status, count]) =>
    '<span class="cache-legend-item"><i class="legend-swatch cache-' + status + '"></i>' + cacheLabels[status] + " " + count + "</span>"
  ).join("");
  elements.cacheChartNote.textContent = observed
    ? "已读取 " + observed + " 个上游缓存信号。"
    : "上游未返回缓存字段，不能据此判定未命中。";
}

function renderDashboard() {
  renderSelectionTools();
  renderModelList();
  renderResults();
  updateSummary();
  updateProgress();
  renderLatencyChart();
  renderTimingChart();
  renderCacheChart();
}

function compactData(data) {
  if (!data) return null;
  const measurement = (value) => value ? {
    totalMs: value.totalMs,
    ttftMs: value.ttftMs,
    mode: value.mode,
    usage: value.usage,
  } : null;
  return {
    model: data.model,
    success: data.success,
    latencyMs: data.latencyMs,
    ttftMs: data.ttftMs,
    outputTokens: data.outputTokens,
    tokensPerSecond: data.tokensPerSecond,
    first: measurement(data.first),
    second: measurement(data.second),
    cache: data.cache,
  };
}

function exportPayload() {
  const results = {};
  const keep = partial ? state.batch : null;
  state.results.forEach((result, model) => {
    if (keep && !keep.includes(model)) return;
    results[model] = {
      status: result.status,
      error: result.error || "",
      data: compactData(result.data),
    };
  });
  return {
    exportedAt: new Date().toISOString(),
    protocol: state.protocol,
    baseUrl: elements.baseUrl.value.trim(),
    profileName: elements.profileName.value.trim(),
    settings: {
      prompt: elements.prompt.value,
      maxTokens: Number(elements.maxTokens.value) || 16,
      concurrency: Number(elements.concurrency.value) || 3,
      timeoutSeconds: formValues().timeoutSeconds,
      cacheProbe: elements.cacheProbe.checked,
    },
    models: state.models,
    results,
  };
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportJson() {
  if (!state.models.length) {
    showError("当前没有模型目录可导出。");
    return;
  }
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  downloadText("model-probe-" + stamp + ".json", JSON.stringify(exportPayload(), null, 2), "application/json");
  setStatus("JSON 报告已导出", "success");
}

function csvValue(value) {
  const text = String(value ?? "");
  return '"' + text.replaceAll('"', '""') + '"';
}

function exportCsv() {
  if (!state.models.length) {
    showError("当前没有模型目录可导出。");
    return;
  }
  const header = ["模型", "状态", "首次延迟(ms)", "TTFT(ms)", "输出速度(tok/s)", "缓存状态", "缓存读取Token", "缓存写入Token", "复测延迟(ms)", "错误"];
  const rows = state.models.map((model) => {
    const result = state.results.get(model.id) || {};
    const data = result.data || {};
    return [
      model.id,
      statusLabels[result.status] || result.status || "待测",
      data.latencyMs,
      data.ttftMs,
      data.tokensPerSecond,
      cacheLabels[data.cache?.status] || "",
      data.cache?.readTokens,
      data.cache?.writeTokens,
      data.second?.totalMs,
      result.error || "",
    ].map(csvValue).join(",");
  });
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "-");
  downloadText("model-probe-" + stamp + ".csv", "\ufeff" + [header.map(csvValue).join(","), ...rows].join("\n"), "text/csv;charset=utf-8");
  setStatus("CSV 报告已导出", "success");
}

function profileMatchesForm(profile) {
  const values = formValues();
  return Boolean(profile)
    && profile.protocol === values.protocol
    && profile.baseUrl === values.baseUrl
    && profile.apiKey === values.apiKey
    && profile.prompt === values.prompt
    && Number(profile.maxTokens) === values.maxTokens
    && Number(profile.concurrency) === values.concurrency
    && Number(profile.timeoutSeconds || 90) === values.timeoutSeconds
    && profile.cacheProbe !== false === values.cacheProbe;
}

function persistRun(stopped, partial) {
  if (!state.models.length) return;
  const tested = [...state.results.keys()];
  const results = {};
  state.results.forEach((result, model) => {
    results[model] = {
      status: result.status,
      error: result.error || "",
      data: compactData(result.data),
    };
  });
  const profile = state.profiles.find((item) => item.id === state.activeProfileId);
  const run = {
    id: makeId("run"),
    profileId: profileMatchesForm(profile) ? profile.id : "",
    profileName: elements.profileName.value.trim() || (protocolName() + " 连接"),
    protocol: state.protocol,
    baseUrl: elements.baseUrl.value.trim(),
    models: state.models,
    results,
    startedAt: state.startedAt || Date.now(),
    finishedAt: Date.now(),
    stopped: Boolean(stopped),
    scope: partial ? state.batchScope : "all",
    tested,
  };
  state.runs = [run].concat(state.runs).slice(0, 12);
  state.activeRunId = run.id;
  writeStorage(STORAGE_KEYS.runs, state.runs);
  elements.lastRunAt.textContent = "本次 " + formatDate(run.finishedAt);
}

async function probeModels(modelIds, scope) {
  if (state.running) return;
  const values = formValues();
  if (!validateConnection(values)) return;
  const idSet = new Set(modelIds);
  const jobs = state.models.filter((model) => idSet.has(model.id) && model.probeable !== false);
  if (!jobs.length && scope !== "all") {
    showError("选中的模型里没有可探测项。");
    return;
  }
  if (!jobs.length) {
    persistRun(false, false);
    return;
  }

  state.running = true;
  state.stopRequested = false;
  state.batch = jobs.map((model) => model.id);
  state.batchScope = scope;
  state.activeRunId = "";
  state.startedAt = Date.now();
  setBusy(true);
  showError("");
  if (scope === "all") {
    state.models.forEach((model) => state.results.set(model.id, model.probeable === false
      ? { status: "skipped", error: "该模型不支持 generateContent。" }
      : { status: "waiting" }));
  } else {
    jobs.forEach((model) => state.results.set(model.id, { status: "waiting" }));
  }
  const scopeLabel = scope === "all"
    ? "全量测试"
    : scope === "selected"
      ? "测试选中"
      : scope === "failed"
        ? "重试失败项"
        : "复测";
  setStatus("准备" + scopeLabel + " " + jobs.length + " 个模型...", "running");
  renderDashboard();

  let cursor = 0;
  const worker = async () => {
    while (!state.stopRequested) {
      const index = cursor;
      cursor += 1;
      if (index >= jobs.length) return;
      const model = jobs[index];
      state.results.set(model.id, { status: "running" });
      setStatus(scopeLabel + " " + (index + 1) + " / " + jobs.length + " · " + model.id, "running");
      renderDashboard();
      try {
        const data = await postJson("/api/probe", {
          protocol: values.protocol,
          baseUrl: values.baseUrl,
          apiKey: values.apiKey,
          model: model.id,
          prompt: values.prompt,
          maxOutputTokens: Math.min(256, Math.max(1, Number(values.maxTokens) || 16)),
          timeoutSeconds: values.timeoutSeconds,
          cacheProbe: values.cacheProbe,
        });
        state.results.set(model.id, { status: "success", data });
      } catch (error) {
        state.results.set(model.id, { status: "error", error: error.message });
      }
      renderDashboard();
    }
  };

  try {
    const concurrency = Math.min(8, Math.max(1, Number(values.concurrency) || 3));
    await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
    if (scope === "all" || scope === "selected") persistRun(state.stopRequested, scope === "selected");
    setStatus(
      state.stopRequested ? "已停止后续任务" : scopeLabel + "完成",
      state.stopRequested ? "" : "success",
    );
    if (state.stopRequested) showError("已停止新任务；已经发出的请求仍会完成，等待中的模型没有发起请求。");
  } catch (error) {
    setStatus(scopeLabel + "失败", "error");
    showError(error.message);
  } finally {
    state.running = false;
    setBusy(false);
    elements.stopProbe.disabled = true;
    renderDashboard();
  }
}

function selectedModels() {
  return state.models.filter((model) => state.selected.has(model.id) && model.probeable !== false);
}

async function runSelected() {
  if (state.running) return;
  if (!state.models.length) {
    showError("请先获取模型目录。");
    return;
  }
  const jobs = selectedModels();
  if (!jobs.length) {
    showError("请先在模型目录里勾选要测试的模型。");
    return;
  }
  await probeModels(jobs.map((model) => model.id), "selected");
}

async function runAll() {
  if (state.running) return;
  if (!state.models.length) {
    showError("请先获取模型目录。");
    return;
  }
  await probeModels(state.models.map((model) => model.id), "all");
}

function stopProbe() {
  if (!state.running) return;
  state.stopRequested = true;
  elements.stopProbe.disabled = true;
  setStatus("正在收尾当前请求...", "running");
}

function loadRun(runId) {
  const run = state.runs.find((item) => item.id === runId);
  if (!run) return;
  const profile = state.profiles.find((item) => item.id === run.profileId);
  if (profile) {
    loadProfile(profile.id);
    elements.baseUrl.value = run.baseUrl || elements.baseUrl.value;
    updateProtocol(run.protocol || profile.protocol);
    updateConnectionSummary();
  } else {
    state.activeProfileId = "";
    elements.profileName.value = run.profileName || "";
    elements.baseUrl.value = run.baseUrl || "";
    elements.apiKey.value = "";
    updateProtocol(run.protocol);
    renderProfiles();
  }
  state.models = run.models || [];
  state.results = new Map(Object.entries(run.results || {}));
  state.selected.clear();
  state.batch = Object.keys(run.results || {});
  state.batchScope = run.scope === "all" ? "all" : run.scope || "";
  state.activeRunId = run.id;
  renderDashboard();
  elements.lastRunAt.textContent = "历史 " + formatDate(run.finishedAt);
  setConnectionStatus(profile ? "已保存" : "需补 Key", profile ? "ready" : "idle");
  setStatus("已载入历史结果", "success");
  showError(profile ? "" : "这条历史记录没有关联已保存配置，重新测试前请填写 API Key 并保存。");
  elements.historyDialog.close();
}

function rerunHistory(runId) {
  const run = state.runs.find((item) => item.id === runId);
  const profile = state.profiles.find((item) => item.id === run?.profileId);
  if (!profile) {
    showError("该历史记录没有可用的已保存配置，请先补充 API Key。");
    elements.historyDialog.close();
    return;
  }
  loadProfile(profile.id);
  elements.historyDialog.close();
  rerunAfterCatalog();
}

async function rerunAfterCatalog() {
  if (!state.models.length) await loadModels();
  if (!state.models.length) return;
  runAll();
}

function deleteRun(runId) {
  state.runs = state.runs.filter((item) => item.id !== runId);
  writeStorage(STORAGE_KEYS.runs, state.runs);
  renderHistory();
}

function clearHistory() {
  if (!state.runs.length || !window.confirm("确定清空全部测试历史吗？")) return;
  state.runs = [];
  writeStorage(STORAGE_KEYS.runs, state.runs);
  renderHistory();
}

function renderHistory() {
  if (!state.runs.length) {
    elements.historyList.innerHTML = '<div class="history-empty"><span class="empty-icon" aria-hidden="true">⌁</span><strong>还没有测试历史</strong><span>完成测试全部或测试选中后会自动保存</span></div>';
    return;
  }
  elements.historyList.innerHTML = state.runs.map((run) => {
    const resultList = Object.values(run.results || {});
    const success = resultList.filter((result) => result.status === "success").length;
    const hits = resultList.filter((result) => result.data?.cache?.status === "hit").length;
    const latencies = resultList
      .map((result) => numericValue(result.data?.latencyMs))
      .filter((value) => value !== null)
      .sort((a, b) => a - b);
    return '<article class="history-item">' +
      '<div class="history-item-main"><div class="history-item-title">' + escapeHtml(run.profileName || "未命名连接") + (run.scope && run.scope !== "all" ? ' <span class="history-scope">部分测试</span>' : "") + '</div>' +
      '<div class="history-item-meta">' + escapeHtml(protocolName(run.protocol)) + " · " + formatDate(run.finishedAt) + " · " + run.models.length + " 个模型" +
      (run.tested?.length ? " · 实测 " + run.tested.length : "") + "</div></div>" +
      '<div class="history-item-stats"><strong>' + success + ' 成功</strong><span>' + hits + " 命中</span><span>P50 " + compactMs(percentile(latencies, 0.5)) + "</span></div>" +
      '<div class="history-item-actions"><button type="button" class="history-action" data-load-run="' + run.id + '">载入</button>' +
      '<button type="button" class="history-action" data-rerun-id="' + run.id + '">重新测试</button>' +
      '<button type="button" class="history-delete" aria-label="删除这条历史记录" title="删除" data-delete-run="' + run.id + '">×</button></div>' +
      "</article>";
  }).join("");
  $$("[data-load-run]").forEach((button) => button.addEventListener("click", () => loadRun(button.dataset.loadRun)));
  $$("[data-rerun-id]").forEach((button) => button.addEventListener("click", () => rerunHistory(button.dataset.rerunId)));
  $$("[data-delete-run]").forEach((button) => button.addEventListener("click", () => {
    if (window.confirm("删除这条测试历史吗？")) deleteRun(button.dataset.deleteRun);
  }));
}

function openHistory() {
  renderHistory();
  if (typeof elements.historyDialog.showModal === "function") elements.historyDialog.showModal();
  else elements.historyDialog.setAttribute("open", "");
}

$$("[data-protocol]").forEach((button) => button.addEventListener("click", () => {
  if (state.running) return;
  state.activeProfileId = "";
  updateProtocol(button.dataset.protocol);
  renderProfiles();
  resetDashboard();
  setConnectionStatus("未保存", "idle");
  setStatus("等待连接", "");
}));

elements.profileSelect.addEventListener("change", () => {
  if (elements.profileSelect.value) loadProfile(elements.profileSelect.value);
  else createNewProfile();
});
elements.saveProfile.addEventListener("click", saveProfile);
elements.deleteProfile.addEventListener("click", deleteProfile);
elements.importCcSwitch.addEventListener("click", importCcSwitchProfiles);
elements.baseUrl.addEventListener("input", updateConnectionSummary);
elements.toggleKey.addEventListener("click", () => {
  const isPassword = elements.apiKey.type === "password";
  elements.apiKey.type = isPassword ? "text" : "password";
  elements.toggleKey.textContent = isPassword ? "○" : "◉";
});
elements.loadModels.addEventListener("click", loadModels);
elements.runAll.addEventListener("click", runAll);
elements.runSelected.addEventListener("click", runSelected);
elements.selectAllModels.addEventListener("click", () => {
  if (state.running) return;
  state.models.forEach((model) => {
    if (model.probeable !== false) state.selected.add(model.id);
  });
  renderDashboard();
});
elements.selectVisibleModels.addEventListener("click", () => {
  if (state.running) return;
  visibleModels().forEach((model) => {
    if (model.probeable !== false) state.selected.add(model.id);
  });
  renderDashboard();
});
elements.invertSelection.addEventListener("click", () => {
  if (state.running) return;
  state.models.forEach((model) => {
    if (model.probeable === false) return;
    if (state.selected.has(model.id)) state.selected.delete(model.id);
    else state.selected.add(model.id);
  });
  renderDashboard();
});
elements.clearSelection.addEventListener("click", () => {
  if (state.running) return;
  state.selected.clear();
  renderDashboard();
});
elements.stopProbe.addEventListener("click", stopProbe);
elements.historyButton.addEventListener("click", openHistory);
elements.closeHistory.addEventListener("click", () => elements.historyDialog.close());
elements.clearHistory.addEventListener("click", clearHistory);
elements.historyDialog.addEventListener("click", (event) => {
  if (event.target === elements.historyDialog) elements.historyDialog.close();
});
elements.modelSearch.addEventListener("input", () => {
  state.modelQuery = elements.modelSearch.value;
  renderDashboard();
});
elements.modelStatusFilter.addEventListener("change", () => {
  state.modelStatusFilter = elements.modelStatusFilter.value;
  renderDashboard();
});
elements.resultSort.addEventListener("change", () => {
  state.resultSort = elements.resultSort.value;
  renderResults();
});
elements.retryFailed.addEventListener("click", () => {
  const failed = state.models.filter((model) => state.results.get(model.id)?.status === "error");
  probeModels(failed.map((model) => model.id), "failed");
});
elements.exportJson.addEventListener("click", exportJson);
elements.exportCsv.addEventListener("click", exportCsv);

state.profiles = readStorage(STORAGE_KEYS.profiles, []).filter((profile) => profile && profile.id);
state.runs = readStorage(STORAGE_KEYS.runs, []).filter((run) => run && run.id);
const savedCatalogs = readStorage(STORAGE_KEYS.catalogs, {});
state.catalogCache = savedCatalogs && typeof savedCatalogs === "object" && !Array.isArray(savedCatalogs)
  ? savedCatalogs
  : {};
renderProfiles();
if (state.profiles.length) {
  const initialProfile = state.profiles.find((profile) => profile.sourceAppType === "codex" && profile.isCurrent)
    || state.profiles.find((profile) => profile.isCurrent)
    || state.profiles[0];
  loadProfile(initialProfile.id);
} else {
  updateProtocol("openai");
  renderDashboard();
  setBusy(false);
}
