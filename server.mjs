import http from "node:http";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const port = Number(process.env.MODEL_PROBE_PORT || 4173);
const maxBodyBytes = 256 * 1024;
const execFileAsync = promisify(execFile);

const PROTOCOLS = new Set(["openai", "google", "claude"]);
const AUTO_PROTOCOL_ORDER = ["openai", "google", "claude"];

class UpstreamError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function normalizeBaseUrl(rawUrl, protocol) {
  let url;
  try {
    url = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("URL 格式不正确。");
  }

  if (!/^https?:$/.test(url.protocol)) {
    throw new Error("URL 只支持 http:// 或 https://。");
  }

  url.search = "";
  url.hash = "";
  let pathname = url.pathname.replace(/\/+$/, "");
  const suffixes = protocol === "google"
    ? ["/models", ":generateContent", ":streamGenerateContent"]
    : ["/models", "/chat/completions", "/messages"];
  for (const suffix of suffixes) {
    if (pathname.endsWith(suffix)) {
      pathname = pathname.slice(0, -suffix.length);
      break;
    }
  }

  if (!pathname && protocol === "google") pathname = "/v1beta";
  if (!pathname && protocol !== "google") pathname = "/v1";
  if (protocol === "google" && pathname === "/") pathname = "/v1beta";
  if (protocol !== "google" && pathname === "/") pathname = "/v1";

  url.pathname = pathname;
  return url.toString().replace(/\/$/, "");
}

function endpoint(base, suffix, query = {}) {
  const url = `${base.replace(/\/$/, "")}/${suffix.replace(/^\//, "")}`;
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null && value !== "") {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed;
}

function headersFor(protocol, apiKey, accept = "application/json") {
  const headers = {
    Accept: accept,
    "Content-Type": "application/json",
  };
  const key = String(apiKey || "").trim();
  if (protocol === "google") {
    headers["x-goog-api-key"] = key;
  } else if (protocol === "claude") {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function appendQuery(url, values) {
  const next = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null && value !== "") {
      next.searchParams.set(key, String(value));
    }
  }
  return next;
}

async function readResponseBody(response, limit = 4 * 1024 * 1024) {
  const text = await response.text();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function summarizeError(text) {
  const compact = String(text || "").replace(/\s+/g, " ").trim();
  if (!compact) return "上游没有返回错误详情。";
  try {
    const parsed = JSON.parse(compact);
    const detail = parsed?.error?.message || parsed?.error || parsed?.message;
    if (typeof detail === "string") return detail.slice(0, 360);
  } catch {
    // Keep the plain upstream message when it is not JSON.
  }
  return compact.slice(0, 360);
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new UpstreamError(`请求超过 ${timeoutMs / 1000} 秒未完成。`, 504);
    }
    throw new UpstreamError(`无法连接上游：${error.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options, timeoutMs = 30000) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  const text = await readResponseBody(response);
  if (!response.ok) {
    throw new UpstreamError(`HTTP ${response.status}: ${summarizeError(text)}`, response.status);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("上游返回的内容不是有效 JSON。", 502);
  }
}

function modelId(value) {
  if (typeof value === "string") return value.trim();
  return String(value?.id || value?.name || "").trim();
}

function normalizeModels(items, protocol) {
  const seen = new Set();
  const models = [];
  for (const item of items) {
    const raw = modelId(item);
    if (!raw) continue;
    const id = protocol === "google" && raw.startsWith("models/")
      ? raw.slice("models/".length)
      : raw;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const supportsGeneration = protocol !== "google"
      || !Array.isArray(item?.supportedGenerationMethods)
      || item.supportedGenerationMethods.includes("generateContent");
    models.push({ id, label: id, probeable: supportsGeneration });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

function parseObject(value) {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readConfigString(config, ...keys) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return "";
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function readTomlString(config, key) {
  if (typeof config !== "string") return "";
  const escapedKey = key.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const match = config.match(new RegExp("^\\s*" + escapedKey + "\\s*=\\s*[\"']([^\"']+)[\"']", "m"));
  return match?.[1]?.trim() || "";
}

function readCodexProviderToml(config) {
  if (typeof config !== "string") return {};
  const selectedProvider = readTomlString(config, "model_provider");
  const model = readTomlString(config, "model");
  const sections = [...config.matchAll(/^\s*\[model_providers\.([^\]]+)\]\s*$/gm)];
  const selectedSection = selectedProvider
    ? sections.find((match) => match[1] === selectedProvider)
    : undefined;
  const sectionStart = selectedSection?.index ?? sections[0]?.index;
  const nextSection = sections.find((match) => (match.index ?? 0) > (sectionStart ?? -1));
  const sectionEnd = nextSection?.index;
  const section = sectionStart === undefined ? config : config.slice(sectionStart, sectionEnd);
  return {
    baseUrl: readTomlString(section, "base_url"),
    model,
  };
}

function ccSwitchProtocol(appType) {
  if (appType === "codex") return "openai";
  if (appType === "claude" || appType === "claude-desktop") return "claude";
  if (appType === "gemini") return "google";
  return "";
}

function ccSwitchBaseUrl(appType, settingsConfig) {
  const env = parseObject(settingsConfig.env);
  const envBaseUrl = [
    "ANTHROPIC_BASE_URL",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "GEMINI_BASE_URL",
  ].map((key) => typeof env[key] === "string" ? env[key].trim() : "")
    .find(Boolean);
  if (envBaseUrl) return envBaseUrl;
  if (appType === "codex") return readCodexProviderToml(settingsConfig.config).baseUrl || "";
  return readConfigString(settingsConfig.config, "baseUrl", "base_url");
}

function ccSwitchApiKey(appType, settingsConfig, meta) {
  const env = parseObject(settingsConfig.env);
  const auth = parseObject(settingsConfig.auth);
  if (appType === "codex") {
    return readConfigString(auth, "OPENAI_API_KEY", "openai_api_key", "apiKey", "api_key");
  }
  if (appType === "claude" || appType === "claude-desktop") {
    const apiKeyField = String(meta.apiKeyField || "").toUpperCase();
    if (apiKeyField === "ANTHROPIC_API_KEY") {
      return readConfigString(env, "ANTHROPIC_API_KEY");
    }
    return readConfigString(env, "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY");
  }
  if (appType === "gemini") {
    return readConfigString(env, "GEMINI_API_KEY", "GOOGLE_API_KEY", "API_KEY")
      || readConfigString(settingsConfig.config, "apiKey", "api_key", "GEMINI_API_KEY", "GOOGLE_API_KEY");
  }
  return "";
}

function ccSwitchProfileId(appType, id) {
  return "ccswitch-" + encodeURIComponent(appType + ":" + id);
}

async function listCcSwitchProfiles() {
  const databasePath = path.join(homedir(), ".cc-switch", "cc-switch.db");
  try {
    await stat(databasePath);
  } catch {
    throw new Error("未找到 CC Switch 本地数据库。请确认 CC Switch 已安装并运行过。");
  }

  const sql = [
    "SELECT id, app_type AS appType, name, settings_config AS settingsConfig,",
    "meta, is_current AS isCurrent FROM providers",
    "ORDER BY app_type, sort_index, name",
  ].join(" ");
  let stdout;
  try {
    ({ stdout } = await execFileAsync("sqlite3", ["-readonly", "-json", databasePath, sql], {
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error("读取 CC Switch 数据库失败：" + (error?.message || "sqlite3 不可用。"));
  }

  let rows;
  try {
    rows = stdout.trim() ? JSON.parse(stdout) : [];
  } catch {
    throw new Error("CC Switch 数据库返回了无法解析的内容。");
  }

  const candidates = rows.map((row) => {
    const appType = String(row.appType || "");
    const protocol = ccSwitchProtocol(appType);
    const settingsConfig = parseObject(row.settingsConfig);
    const meta = parseObject(row.meta);
    const id = String(row.id || "");
    const baseUrl = ccSwitchBaseUrl(appType, settingsConfig);
    const apiKey = ccSwitchApiKey(appType, settingsConfig, meta);
    if (!protocol || !id || !baseUrl || !apiKey) return null;
    return {
      id: ccSwitchProfileId(appType, id),
      source: "CC Switch",
      sourceId: id,
      sourceAppType: appType,
      sourceName: String(row.name || "未命名配置"),
      protocol,
      baseUrl,
      apiKey,
      isCurrent: Number(row.isCurrent) === 1,
    };
  }).filter(Boolean);

  const nameCounts = new Map();
  candidates.forEach((candidate) => {
    nameCounts.set(candidate.sourceName, (nameCounts.get(candidate.sourceName) || 0) + 1);
  });
  const profiles = candidates.map((candidate) => ({
    id: candidate.id,
    name: nameCounts.get(candidate.sourceName) > 1
      ? candidate.sourceName + " (" + candidate.sourceAppType + " - " + candidate.sourceId.slice(-8) + ")"
      : candidate.sourceName,
    source: candidate.source,
    sourceId: candidate.sourceId,
    sourceAppType: candidate.sourceAppType,
    protocol: candidate.protocol,
    baseUrl: candidate.baseUrl,
    apiKey: candidate.apiKey,
    isCurrent: candidate.isCurrent,
    importedAt: Date.now(),
  }));
  return {
    profiles,
    total: rows.length,
    skipped: rows.length - profiles.length,
  };
}

async function listModels(input) {
  const protocol = String(input.protocol || "");
  if (protocol === "auto") {
    let lastError;
    for (const candidate of AUTO_PROTOCOL_ORDER) {
      try {
        const result = await listModels({ ...input, protocol: candidate });
        if (result.models.length) return { ...result, protocol: candidate, detected: true };
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      throw new UpstreamError("自动识别失败：未找到可用的 OpenAI、Google 或 Claude 模型列表。", lastError.status || 502);
    }
    throw new Error("自动识别失败：接口没有返回可用模型。");
  }
  if (!PROTOCOLS.has(protocol)) throw new Error("不支持的协议。");
  const base = normalizeBaseUrl(input.baseUrl, protocol);
  const headers = headersFor(protocol, input.apiKey);

  if (protocol === "google") {
    const items = [];
    let pageToken = "";
    for (let page = 0; page < 10; page += 1) {
      const response = await fetchJson(
        appendQuery(endpoint(base, "models"), { pageSize: 1000, pageToken }),
        { method: "GET", headers },
      );
      items.push(...(Array.isArray(response.models) ? response.models : []));
      pageToken = response.nextPageToken || "";
      if (!pageToken) break;
    }
    return { protocol, baseUrl: base, models: normalizeModels(items, protocol) };
  }

  const response = await fetchJson(
    endpoint(base, "models"),
    { method: "GET", headers },
  );
  return {
    protocol,
    baseUrl: base,
    models: normalizeModels(Array.isArray(response.data) ? response.data : [], protocol),
  };
}

function readNumber(value, ...keys) {
  for (const key of keys) {
    const candidate = Number(value?.[key]);
    if (Number.isFinite(candidate) && candidate >= 0) return candidate;
  }
  return null;
}

function nestedNumber(value, ...path) {
  let current = value;
  for (const key of path) current = current?.[key];
  const number = Number(current);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function extractUsage(usage, protocol) {
  if (!usage || typeof usage !== "object") {
    return { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheFieldsPresent: false, source: null };
  }

  if (protocol === "google") {
    const cacheReadTokens = readNumber(usage, "cachedContentTokenCount");
    return {
      inputTokens: readNumber(usage, "promptTokenCount"),
      outputTokens: readNumber(usage, "candidatesTokenCount"),
      cacheReadTokens,
      cacheWriteTokens: null,
      cacheFieldsPresent: Object.hasOwn(usage, "cachedContentTokenCount"),
      source: "Google usageMetadata",
    };
  }

  const detail = usage.prompt_tokens_details || usage.input_tokens_details || usage.inputTokenDetails;
  const cacheReadTokens = readNumber(
    usage,
    "cache_read_input_tokens",
    "cached_tokens",
    "cacheReadInputTokens",
  ) ?? readNumber(detail, "cached_tokens", "cachedTokens");
  const cacheWriteTokens = readNumber(
    usage,
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
  ) ?? readNumber(detail, "cache_creation_input_tokens", "cacheCreationInputTokens");
  const cacheFieldsPresent = [
    "cache_read_input_tokens",
    "cached_tokens",
    "cache_creation_input_tokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
  ].some((key) => Object.hasOwn(usage, key))
    || ["cached_tokens", "cachedTokens", "cache_creation_input_tokens", "cacheCreationInputTokens"]
      .some((key) => Object.hasOwn(detail || {}, key));

  return {
    inputTokens: readNumber(usage, "input_tokens", "prompt_tokens", "inputTokens", "promptTokens"),
    outputTokens: readNumber(usage, "output_tokens", "completion_tokens", "outputTokens", "completionTokens"),
    cacheReadTokens,
    cacheWriteTokens,
    cacheFieldsPresent,
    source: protocol === "claude" ? "Claude usage" : "OpenAI usage",
  };
}

function mergeUsage(target, next) {
  if (!next) return target;
  for (const key of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"]) {
    if (next[key] !== null && next[key] !== undefined) target[key] = next[key];
  }
  target.cacheFieldsPresent ||= Boolean(next.cacheFieldsPresent);
  target.source ||= next.source;
  return target;
}

function eventRecords(text) {
  return String(text)
    .replace(/\r\n/g, "\n")
    .split(/\n\n+/)
    .map((record) => {
      const event = record.match(/^event:\s*(.+)$/m)?.[1]?.trim() || "";
      const data = record
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return { event, data };
    })
    .filter((record) => record.data);
}

function textFromPayload(payload, protocol) {
  if (protocol === "google") {
    return payload?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("") || "";
  }
  if (protocol === "claude") {
    if (payload?.delta?.text) return payload.delta.text;
    return payload?.content
      ?.filter((part) => part?.type === "text")
      ?.map((part) => part.text || "")
      ?.join("") || "";
  }
  return payload?.choices?.[0]?.delta?.content
    || payload?.choices?.[0]?.message?.content
    || "";
}

function usageFromPayload(payload, protocol) {
  const usage = protocol === "google"
    ? payload?.usageMetadata
    : protocol === "claude"
      ? payload?.usage || payload?.message?.usage
      : payload?.usage;
  return extractUsage(usage, protocol);
}

function openAiPayload(model, prompt, maxOutputTokens, stream, cacheProbe) {
  const payload = {
    model,
    messages: [{ role: "user", content: prompt }],
    stream,
  };
  if (/^(gpt-5|o[1-9]|o-mini)/i.test(model)) payload.max_completion_tokens = maxOutputTokens;
  else payload.max_tokens = maxOutputTokens;
  if (stream) payload.stream_options = { include_usage: true };
  if (cacheProbe) payload.messages.unshift({ role: "system", content: `Stable cache probe prefix.\n${prompt}` });
  return payload;
}

function googlePayload(prompt, maxOutputTokens) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens },
  };
}

function claudePayload(model, prompt, maxOutputTokens, stream, cacheProbe) {
  const payload = {
    model,
    max_tokens: maxOutputTokens,
    messages: [{ role: "user", content: prompt }],
    stream,
  };
  if (cacheProbe) {
    payload.system = [{
      type: "text",
      text: `Stable cache probe prefix.\n${prompt}`,
      cache_control: { type: "ephemeral" },
    }];
    payload.messages = [{ role: "user", content: "Reply with a short acknowledgement." }];
  }
  return payload;
}

function streamEndpoint(base, protocol, model) {
  if (protocol === "google") {
    return endpoint(base, `models/${encodeURIComponent(model)}:streamGenerateContent`, { alt: "sse" });
  }
  return endpoint(base, protocol === "claude" ? "messages" : "chat/completions");
}

function normalEndpoint(base, protocol, model) {
  if (protocol === "google") return endpoint(base, `models/${encodeURIComponent(model)}:generateContent`);
  return endpoint(base, protocol === "claude" ? "messages" : "chat/completions");
}

function shouldFallback(error) {
  return error instanceof UpstreamError && [400, 404, 405, 422].includes(error.status);
}

async function streamProbe({ protocol, base, apiKey, model, prompt, maxOutputTokens, cacheProbe, timeoutMs = 90000 }) {
  const payload = protocol === "google"
    ? googlePayload(prompt, maxOutputTokens)
    : protocol === "claude"
      ? claudePayload(model, prompt, maxOutputTokens, true, cacheProbe)
      : openAiPayload(model, prompt, maxOutputTokens, true, cacheProbe);
  const startedAt = performance.now();
  const response = await fetchWithTimeout(
    streamEndpoint(base, protocol, model),
    {
      method: "POST",
      headers: headersFor(protocol, apiKey, "text/event-stream, application/json"),
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );
  const responseTextType = response.headers.get("content-type") || "";
  if (!response.ok) {
    throw new UpstreamError(`HTTP ${response.status}: ${summarizeError(await readResponseBody(response))}`, response.status);
  }

  const usage = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, cacheFieldsPresent: false, source: null };
  let output = "";
  let ttftMs = null;
  let rawBuffer = "";

  if (!response.body || responseTextType.includes("application/json")) {
    const raw = await readResponseBody(response);
    try {
      const payloadObject = JSON.parse(raw);
      output = textFromPayload(payloadObject, protocol);
      mergeUsage(usage, usageFromPayload(payloadObject, protocol));
    } catch {
      throw new UpstreamError("流式请求返回了无法解析的内容。", 502);
    }
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const consumeRecords = (records) => {
      for (const record of records) {
        if (record.data === "[DONE]") continue;
        let payloadObject;
        try {
          payloadObject = JSON.parse(record.data);
        } catch {
          continue;
        }
        const piece = textFromPayload(payloadObject, protocol);
        if (piece && ttftMs === null) ttftMs = Math.round(performance.now() - startedAt);
        output += piece;
        mergeUsage(usage, usageFromPayload(payloadObject, protocol));
      }
    };
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      rawBuffer += decoder.decode(value, { stream: true });
      rawBuffer = rawBuffer.replace(/\r\n/g, "\n");
      const lastBoundary = rawBuffer.lastIndexOf("\n\n");
      if (lastBoundary >= 0) {
        const completeRecords = rawBuffer.slice(0, lastBoundary + 2);
        rawBuffer = rawBuffer.slice(lastBoundary + 2);
        consumeRecords(eventRecords(completeRecords));
      }
    }
    rawBuffer += decoder.decode();
    consumeRecords(eventRecords(rawBuffer));
  }

  const totalMs = Math.max(0, Math.round(performance.now() - startedAt));
  return { totalMs, ttftMs, output, usage, mode: "stream" };
}

async function normalProbe({ protocol, base, apiKey, model, prompt, maxOutputTokens, cacheProbe, timeoutMs = 90000 }) {
  const payload = protocol === "google"
    ? googlePayload(prompt, maxOutputTokens)
    : protocol === "claude"
      ? claudePayload(model, prompt, maxOutputTokens, false, cacheProbe)
      : openAiPayload(model, prompt, maxOutputTokens, false, cacheProbe);
  const startedAt = performance.now();
  const response = await fetchWithTimeout(
    normalEndpoint(base, protocol, model),
    {
      method: "POST",
      headers: headersFor(protocol, apiKey),
      body: JSON.stringify(payload),
    },
    timeoutMs,
  );
  const raw = await readResponseBody(response);
  if (!response.ok) {
    throw new UpstreamError(`HTTP ${response.status}: ${summarizeError(raw)}`, response.status);
  }
  let payloadObject;
  try {
    payloadObject = JSON.parse(raw);
  } catch {
    throw new UpstreamError("上游返回的内容不是有效 JSON。", 502);
  }
  return {
    totalMs: Math.max(0, Math.round(performance.now() - startedAt)),
    ttftMs: null,
    output: textFromPayload(payloadObject, protocol),
    usage: usageFromPayload(payloadObject, protocol),
    mode: "json",
  };
}

async function probeOnce(args) {
  try {
    return await streamProbe(args);
  } catch (error) {
    if (!shouldFallback(error)) throw error;
    return normalProbe(args);
  }
}

function cacheSummary(first, second) {
  const observed = [first, second].filter(Boolean);
  const hasFields = observed.some((item) => item.usage.cacheFieldsPresent);
  const read = observed.map((item) => item.usage.cacheReadTokens || 0).reduce((a, b) => Math.max(a, b), 0);
  const write = observed.map((item) => item.usage.cacheWriteTokens || 0).reduce((a, b) => Math.max(a, b), 0);
  let status = "unknown";
  if (read > 0) status = "hit";
  else if (write > 0) status = "write";
  else if (hasFields) status = "miss";
  return {
    status,
    readTokens: read || null,
    writeTokens: write || null,
    source: observed.find((item) => item.usage.source)?.usage.source || null,
    fieldsObserved: hasFields,
  };
}

async function probeModel(input) {
  const protocol = String(input.protocol || "");
  if (!PROTOCOLS.has(protocol)) throw new Error("不支持的协议。");
  const model = String(input.model || "").trim();
  if (!model) throw new Error("缺少模型名称。");
  const prompt = String(input.prompt || "").trim();
  if (!prompt) throw new Error("测试提示词不能为空。");
  const base = normalizeBaseUrl(input.baseUrl, protocol);
  const args = {
    protocol,
    base,
    apiKey: input.apiKey,
    model,
    prompt,
    maxOutputTokens: Math.min(256, Math.max(1, Number(input.maxOutputTokens) || 16)),
    timeoutMs: Math.min(180000, Math.max(10000, (Number(input.timeoutSeconds) || 90) * 1000)),
    cacheProbe: Boolean(input.cacheProbe),
  };
  const first = await probeOnce(args);
  const second = args.cacheProbe ? await probeOnce(args) : null;
  const selected = second || first;
  const outputTokens = selected.usage.outputTokens;
  const generationMs = selected.ttftMs !== null
    ? Math.max(1, selected.totalMs - selected.ttftMs)
    : selected.totalMs;
  return {
    model,
    success: true,
    first: serializeMeasurement(first),
    second: second ? serializeMeasurement(second) : null,
    latencyMs: first.totalMs,
    ttftMs: first.ttftMs,
    outputTokens,
    tokensPerSecond: outputTokens && generationMs > 0 ? Number((outputTokens / (generationMs / 1000)).toFixed(2)) : null,
    cache: cacheSummary(first, second),
  };
}

function serializeMeasurement(measurement) {
  return {
    totalMs: measurement.totalMs,
    ttftMs: measurement.ttftMs,
    mode: measurement.mode,
    outputPreview: measurement.output.slice(0, 120),
    usage: measurement.usage,
  };
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBodyBytes) throw new Error("请求内容过大。");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("请求 JSON 格式不正确。");
  }
}

function contentType(filePath) {
  const ext = path.extname(filePath);
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
  }[ext] || "application/octet-stream";
}

async function serveStatic(req, res) {
  const requestPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType(filePath), "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/models") {
      const result = await listModels(await readJsonBody(req));
      json(res, 200, result);
      return;
    }
    if (req.method === "POST" && req.url === "/api/probe") {
      const result = await probeModel(await readJsonBody(req));
      json(res, 200, result);
      return;
    }
    if (req.method === "GET" && req.url === "/api/ccswitch/profiles") {
      const result = await listCcSwitchProfiles();
      json(res, 200, result);
      return;
    }
    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }
    json(res, 405, { error: "Method Not Allowed" });
  } catch (error) {
    const status = Number(error?.status) || 400;
    json(res, status >= 400 && status < 600 ? status : 500, { error: error.message || "请求失败。" });
  }
});

server.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : port;
  console.log(`Model Probe running at http://127.0.0.1:${listeningPort}`);
});

export { server };
