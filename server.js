const express = require("express");
const http = require("http");
const https = require("https");
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const alasql = require("alasql");
const { SocksProxyAgent } = require("socks-proxy-agent");

const LISTEN_HOST = process.env.LISTEN_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8080);
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || "";
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, "config.json");
const RESPONSE_STATE_FILE = process.env.RESPONSE_STATE_FILE || path.join(__dirname, "responses-state.json");
const METRICS_FILE = process.env.METRICS_FILE || path.join(__dirname, "llm-metrics.json");
const USAGE_FILE = process.env.USAGE_FILE || path.join(__dirname, "llm-usage.json");
const RESPONSE_SESSIONS_FILE = process.env.RESPONSE_SESSIONS_FILE || path.join(__dirname, "responses-sessions.json");

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.raw({ type: "application/octet-stream", limit: "50mb" }));

const DEFAULT_CONFIG = { chat_completions: [], responses: [] };
function loadConfig() { try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; } catch { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); } }
function saveJson(file, value) { const tmp = `${file}.tmp`; fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(tmp, file); }
function saveConfig(config) { saveJson(CONFIG_FILE, config); }
let config = loadConfig();
if (!fs.existsSync(CONFIG_FILE)) saveConfig(config);
let responseState = {};
try { responseState = JSON.parse(fs.readFileSync(RESPONSE_STATE_FILE, "utf8")); } catch {}
function saveResponseState() { saveJson(RESPONSE_STATE_FILE, responseState); }
let metrics = {};
try { metrics = JSON.parse(fs.readFileSync(METRICS_FILE, "utf8")); } catch {}
function saveMetrics() { saveJson(METRICS_FILE, metrics); }
let responseSessions = [];
try { responseSessions = JSON.parse(fs.readFileSync(RESPONSE_SESSIONS_FILE, "utf8")); if (!Array.isArray(responseSessions)) responseSessions = []; } catch {}
function saveResponseSessions() { saveJson(RESPONSE_SESSIONS_FILE, responseSessions.slice(-100)); }
function createResponseSession(body, chatBody, entry) {
  const previousSession = body.previous_response_id && responseSessions.find((item) => item.response_id === body.previous_response_id);
  const conversationId = previousSession?.conversation_id || `conversation_${randomId()}`;
  const turn = responseSessions.filter((item) => item.conversation_id === conversationId).length + 1;
  const session = { id: `session_${randomId()}`, conversation_id: conversationId, turn, at: new Date().toISOString(), model: body.model, upstream_model: chatBody.model, upstream_url: makeTargetUrl(entry, "responses", true).href, status: "in_progress", request: body, chat_request: chatBody };
  responseSessions.push(session); responseSessions = responseSessions.slice(-100); saveResponseSessions(); return session;
}
function updateResponseSession(session, patch) { Object.assign(session, patch, { updated_at: new Date().toISOString() }); saveResponseSessions(); }
function metricKey(type, entry) { return `${type}:${entry.id}`; }
function recordMetric(type, entry, sample) {
  const key = metricKey(type, entry);
  const history = Array.isArray(metrics[key]) ? metrics[key] : [];
  history.push({ ...sample, at: new Date().toISOString(), model: entry.public_model });
  metrics[key] = history.slice(-10);
  saveMetrics();
}
function metricTracker(type, entry) {
  const startedEpoch = Date.now();
  const startedAt = process.hrtime.bigint();
  let firstTextAt = null, text = "", usage = null, buffer = "", toolCallIds = new Set(), hadTool = false;
  const consumeData = (data) => {
    if (!data || typeof data !== "object") return;
    if (data.usage) usage = data.usage;
    const calls = data.choices?.[0]?.delta?.tool_calls || data.choices?.[0]?.message?.tool_calls || [];
    if (calls.length) { calls.forEach((call) => toolCallIds.add(call.id || call.index || call.function?.name || JSON.stringify(call))); hadTool = true; }
    const delta = typeof data.delta === "string" ? data.delta : (data.choices?.[0]?.delta?.content || data.choices?.[0]?.message?.content || data.output_text?.delta || "");
    if (!delta) return;
    if (firstTextAt === null) firstTextAt = process.hrtime.bigint();
    text += delta;
  };
  const consume = (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") continue;
      try { consumeData(JSON.parse(raw)); } catch {}
    }
  };
  const finishMetric = (status) => {
    consume("");
    const finishedAt = process.hrtime.bigint();
    const ttftMs = firstTextAt === null ? null : Number(firstTextAt - startedAt) / 1e6;
    const generationMs = firstTextAt === null ? 0 : Number(finishedAt - firstTextAt) / 1e6;
    const tokens = usage?.completion_tokens ?? usage?.output_tokens ?? null;
    const chars = [...text].length;
    const toolCalls = toolCallIds.size;
    const response_kind = !hadTool ? "reply" : text ? "tool_call_with_reply" : "tool_call_only";
    recordMetric(type, entry, { status, response_kind, tool_calls: toolCalls, has_reply: Boolean(text), ttft_ms: ttftMs == null ? null : Math.round(ttftMs), tokens_per_second: tokens != null && generationMs > 0 ? Math.round(tokens / (generationMs / 1000) * 10) / 10 : null, chars_per_second: chars && generationMs > 0 ? Math.round(chars / (generationMs / 1000) * 10) / 10 : null, completion_tokens: tokens, generated_chars: chars });
  };
  return { type, entry, startedEpoch, consume, consumeJson: consumeData, finish(status) { recordUsage(type, entry, startedEpoch, status, usage); finishMetric(status); }, finishMetric };
}

const usageDb = new alasql.Database("llm_proxy_usage");
usageDb.exec(`CREATE TABLE IF NOT EXISTS calls (
  id STRING, at STRING, type STRING, config_id STRING, public_model STRING,
  upstream_model STRING, status INT, input_tokens INT, cached_tokens INT,
  output_tokens INT, cache_cost NUMBER, prefill_cost NUMBER,
  generation_cost NUMBER, total_cost NUMBER, duration_ms INT
)`);
function loadUsage() {
  try {
    const rows = JSON.parse(fs.readFileSync(USAGE_FILE, "utf8"));
    if (Array.isArray(rows)) for (const row of rows) usageDb.tables.calls.data.push(row);
  } catch {}
}
function saveUsage() {
  const tmp = `${USAGE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(usageDb.exec("SELECT * FROM calls ORDER BY at DESC"), null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USAGE_FILE);
}
loadUsage();
function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function usageTokens(usage) {
  if (!usage) return { input: null, cached: 0, output: null };
  return {
    input: numberOrNull(usage.prompt_tokens ?? usage.input_tokens),
    cached: numberOrNull(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens ?? usage.cached_tokens) ?? 0,
    output: numberOrNull(usage.completion_tokens ?? usage.output_tokens)
  };
}
function recordUsage(type, entry, startedAt, status, usage) {
  const t = usageTokens(usage);
  const cache = numberOrNull(entry.cache_price) ?? 0;
  const prefill = numberOrNull(entry.prefill_price) ?? 0;
  const generation = numberOrNull(entry.generation_price) ?? 0;
  const prefillTokens = Math.max(0, (t.input ?? 0) - t.cached);
  const cacheCost = t.cached * cache / 1_000_000;
  const prefillCost = prefillTokens * prefill / 1_000_000;
  const generationCost = (t.output ?? 0) * generation / 1_000_000;
  usageDb.exec("INSERT INTO calls VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", [
    randomId(), new Date().toISOString(), type, entry.id, entry.public_model,
    entry.upstream_model || entry.public_model, status ?? null, t.input, t.cached, t.output,
    cacheCost, prefillCost, generationCost, cacheCost + prefillCost + generationCost,
    Math.max(0, Date.now() - startedAt)
  ]);
  try { saveUsage(); } catch (e) { console.error("Save usage error:", e.message); }
}
function publicUsage() {
  const summary = usageDb.exec(`SELECT type, config_id, public_model, COUNT(*) AS calls,
    COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
    COALESCE(SUM(output_tokens), 0) AS output_tokens, COALESCE(SUM(cache_cost), 0) AS cache_cost,
    COALESCE(SUM(prefill_cost), 0) AS prefill_cost, COALESCE(SUM(generation_cost), 0) AS generation_cost,
    COALESCE(SUM(total_cost), 0) AS total_cost FROM calls
    GROUP BY type, config_id, public_model ORDER BY total_cost DESC`);
  return { summary, recent: usageDb.exec("SELECT * FROM calls ORDER BY at DESC LIMIT 200") };
}

function upstreamFor(type, publicModel) { return (config[type] || []).find((x) => x.public_model === publicModel && x.enabled !== false); }
function sanitizeConfig() { return { chat_completions: (config.chat_completions || []).map((x) => ({ ...x, key: x.key ? "********" : "" })), responses: (config.responses || []).map((x) => ({ ...x, key: x.key ? "********" : "" })) }; }
function getBodyObject(req) { if (req.body && typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body; try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "{}"); } catch { return {}; } }
function getBodyBuffer(req) { if (Buffer.isBuffer(req.body)) return req.body; if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body)); return Buffer.alloc(0); }
function hopByHop(name) { return ["connection", "proxy-connection", "keep-alive", "transfer-encoding", "host", "content-length"].includes(name.toLowerCase()); }
function entryUsesProxy(entry) { return entry.use_proxy !== false && Boolean(SOCKS5_PROXY); }
function makeTargetUrl(entry, type, forceChat = false) {
  const raw = String(entry.url || "").trim();
  if (!raw) throw new Error("Upstream URL is empty");
  const target = new URL(raw);
  if (!target.pathname || target.pathname === "/") target.pathname = forceChat || type === "chat_completions" ? "/v1/chat/completions" : "/v1/responses";
  if (forceChat) target.pathname = target.pathname.replace(/\/responses\/?$/, "/chat/completions");
  return target;
}
function contentPartToChat(part) {
  if (typeof part === "string") return { type: "text", text: part };
  if (!part || typeof part !== "object") return null;
  if (part.type === "input_text" || part.type === "output_text" || part.type === "text") return { type: "text", text: part.text || "" };
  if (part.type === "input_image" || part.type === "image_url") {
    const url = part.image_url?.url || part.image_url || part.url;
    return url ? { type: "image_url", image_url: { url } } : null;
  }
  if (part.type === "input_audio" || part.type === "audio") {
    return part.input_audio ? { type: "input_audio", input_audio: part.input_audio } : null;
  }
  return null;
}
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((x) => typeof x === "string" ? x : (x?.text || "")).join("");
}
function responseContentToChat(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = content.map(contentPartToChat).filter(Boolean);
  return parts.length === 1 && parts[0].type === "text" ? parts[0].text : parts;
}
function responseInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  const messages = [];
  for (const item of input) {
    if (typeof item === "string") { messages.push({ role: "user", content: item }); continue; }
    if (!item || typeof item !== "object") continue;
    // Tool definitions carried by some Responses clients are transport metadata,
    // not conversation items. They are extracted separately before conversion.
    if (item.type === "additional_tools" || item.type === "tools") continue;
    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
      continue;
    }
    if (item.type === "function_call" || item.type === "custom_tool_call") {
      messages.push({ role: "assistant", tool_calls: [{ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.type === "custom_tool_call" ? JSON.stringify({ input: item.input || "" }) : item.arguments || "" } }] });
      continue;
    }
    const role = item.role || (item.type === "message" ? "user" : "user");
    const content = responseContentToChat(item.content ?? item.text ?? "");
    if ((typeof content === "string" && content !== "") || (Array.isArray(content) && content.length)) messages.push({ role, content });
  }
  return messages;
}
function responseToolsToChat(tools) {
  if (!Array.isArray(tools)) return [];
  const result = [];
  const visit = (tool) => {
    if (!tool || typeof tool !== "object") return;
    // Some clients wrap tools in namespaces (for example
    // { type: "namespace", tools: [...] }); flatten those wrappers.
    if (Array.isArray(tool.tools)) { tool.tools.forEach(visit); return; }
    const source = tool.function && typeof tool.function === "object" ? tool.function : tool;
    const name = source.name || tool.name;
    // Chat Completions can only receive callable function tools. Ignore other
    // Responses-only metadata such as web_search_preview.
    if (!name || !["function", "custom"].includes(tool.type || source.type || "function")) return;
    const custom = tool.type === "custom";
    const parameters = custom ? { type: "object", properties: { input: { type: "string", description: "The raw source text to execute, following the tool description. Never put command arguments or a JSON object here." } }, required: ["input"], additionalProperties: false } : source.parameters || source.input_schema || tool.parameters || tool.input_schema || { type: "object", properties: {} };
    const description = (source.description || tool.description || "") + (custom ? "\nTransport adapter: supply the raw tool input as the string in the JSON input property. For JavaScript tools, write JavaScript that calls the documented tools methods." : "");
    result.push({ type: "function", function: { name, description, parameters, ...(source.strict !== undefined || tool.strict !== undefined ? { strict: source.strict ?? tool.strict } : {}) } });
  };
  tools.forEach(visit);
  return result;
}
function responseRequestTools(body) {
  const tools = Array.isArray(body.tools) ? [...body.tools] : [];
  // A few Responses clients put their tool registry in an input metadata item.
  if (Array.isArray(body.input)) for (const item of body.input) {
    if (item && typeof item === "object" && Array.isArray(item.tools)) tools.push(...item.tools);
  }
  return tools;
}
function mergeChatTools(...groups) {
  const merged = new Map();
  for (const tools of groups) for (const tool of tools || []) {
    const name = tool?.function?.name;
    if (name) merged.set(name, tool);
  }
  return [...merged.values()];
}
function responseToolsForResponse(tools) {
  const result = [];
  const visit = (tool) => {
    if (!tool || typeof tool !== "object") return;
    if (Array.isArray(tool.tools)) { tool.tools.forEach(visit); return; }
    if (tool.type === "function" && tool.function) {
      result.push({ type: "function", name: tool.function.name, description: tool.function.description || "", parameters: tool.function.parameters || { type: "object", properties: {} }, ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}) });
    } else if (tool.type === "custom" && tool.name) {
      result.push({ type: "custom", name: tool.name, description: tool.description || "" });
    } else if (tool.type === "function" && tool.name) result.push(tool);
  };
  (Array.isArray(tools) ? tools : []).forEach(visit);
  return result;
}
function responseRequestToChat(body, state) {
  const currentMessages = [];
  if (body.instructions) currentMessages.push({ role: "system", content: responseContentToChat(body.instructions) });
  let messages = [...currentMessages];
  let previousTools = [];
  if (body.previous_response_id) {
    const previous = state[body.previous_response_id];
    if (!previous) throw new Error(`Unknown previous_response_id: ${body.previous_response_id}`);
    messages = [...previous.messages, ...currentMessages];
    previousTools = previous.tools || [];
  }
  const requestMessages = responseInputToMessages(body.input);
  currentMessages.push(...requestMessages);
  messages.push(...requestMessages);
  const requestTools = responseRequestTools(body);
  if (requestTools.length) console.log(`[responses tools] received ${requestTools.length}: ${JSON.stringify(requestTools, null, 2)}`);
  const tools = mergeChatTools(previousTools, responseToolsToChat(requestTools));
  if (requestTools.length && !tools.length) console.error("[responses tools] conversion produced no tools", JSON.stringify(requestTools));
  console.log(`[responses tools] converted ${tools.length}: ${JSON.stringify(tools, null, 2)}`);
  const chat = { model: body.model, messages };
  const allowed = ["temperature", "top_p", "stream", "stop", "presence_penalty", "frequency_penalty", "seed", "response_format", "logprobs", "top_logprobs", "n"];
  for (const key of allowed) if (body[key] !== undefined) chat[key] = body[key];
  if (body.max_output_tokens != null) chat.max_completion_tokens = body.max_output_tokens;
  if (body.max_tokens != null) chat.max_tokens = body.max_tokens;
  if (tools.length) chat.tools = tools;
  else if (requestTools.length) console.log("[responses tools] no convertible tools found");
  if (body.tool_choice !== undefined) {
    chat.tool_choice = body.tool_choice === "function" ? "required" : body.tool_choice;
    if (body.tool_choice?.type === "function") chat.tool_choice = { type: "function", function: { name: body.tool_choice.name || body.tool_choice.function?.name } };
  }
  return { chat, requestMessages: currentMessages, tools, responseTools: requestTools };
}
function responseUsage(usage) {
  if (!usage) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const input = numberOrNull(usage.input_tokens ?? usage.prompt_tokens) ?? 0;
  const output = numberOrNull(usage.output_tokens ?? usage.completion_tokens) ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: numberOrNull(usage.total_tokens) ?? input + output,
    ...(usage.input_tokens_details || usage.prompt_tokens_details ? { input_tokens_details: usage.input_tokens_details || usage.prompt_tokens_details } : {})
  };
}
function chatAssistantMessageToHistory(message) {
  const result = { role: "assistant", content: message?.content || "" };
  if (message?.tool_calls?.length) result.tool_calls = message.tool_calls.map((call) => ({ id: call.id, type: "function", function: { name: call.function?.name, arguments: call.function?.arguments || "" } }));
  return result;
}
function responseCallItem(call, tools, status = "completed") {
  const custom = responseToolsForResponse(tools).some((tool) => tool.type === "custom" && tool.name === call.name);
  if (custom) {
    let input = "";
    if (status === "completed") {
      const parsed = JSON.parse(call.arguments || "{}");
      if (typeof parsed.input !== "string") throw new Error(`Custom tool ${call.name} requires a string input`);
      input = parsed.input;
    }
    return { id: call.itemId, type: "custom_tool_call", status, name: call.name, input, call_id: call.id };
  }
  return { id: call.itemId, type: "function_call", status, name: call.name, arguments: call.arguments || "", call_id: call.id };
}
function chatMessageToResponseOutput(message, tools = []) {
  const content = message?.content;
  const textParts = typeof content === "string" ? (content ? [{ type: "output_text", text: content, annotations: [] }] : []) : Array.isArray(content) ? content.filter((part) => part?.text).map((part) => ({ type: "output_text", text: part.text, annotations: [] })) : [];
  const output = [];
  if (textParts.length) output.push({ id: `msg_${randomId()}`, type: "message", role: "assistant", status: "completed", content: textParts });
  if (message?.tool_calls?.length) for (const call of message.tool_calls) {
    const callId = call.id || `call_${randomId()}`;
    output.push(responseCallItem({ itemId: `fc_${randomId()}`, id: callId, name: call.function?.name, arguments: call.function?.arguments || "" }, tools));
  }
  return output;
}
function randomId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function chatToResponse(data, publicModel, state, previousId, requestMessages = [], requestTools = [], responseTools = []) {
  const id = `resp_${randomId()}`;
  const message = data.choices?.[0]?.message || { role: "assistant", content: "" };
  const output = chatMessageToResponseOutput(message, responseTools);
  const assistantMessages = [chatAssistantMessageToHistory(message)];
  state[id] = { messages: [...(previousId && state[previousId] ? state[previousId].messages : []), ...requestMessages, ...assistantMessages], tools: requestTools, created_at: Math.floor(Date.now() / 1000) };
  saveResponseState();
  const text = output.flatMap((x) => x.content || []).filter((x) => x.type === "output_text").map((x) => x.text).join("");
  return { id, object: "response", created_at: state[id].created_at, status: "completed", error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model: publicModel, output, parallel_tool_calls: true, previous_response_id: previousId || null, reasoning: { effort: null, summary: null }, service_tier: null, store: true, temperature: data.temperature ?? null, text: { format: { type: "text" } }, tool_choice: data.tool_choice || "auto", tools: responseToolsForResponse(responseTools), top_p: data.top_p ?? null, truncation: "disabled", usage: responseUsage(data.usage), metadata: {}, output_text: text };
}

function proxyRequest(req, res, type) {
  const original = getBodyObject(req);
  const publicModel = original.model;
  const entry = upstreamFor(type, publicModel);
  if (!entry) return res.status(404).json({ error: { message: `No upstream configured for model: ${publicModel || "(missing)"}`, type: "model_not_configured" } });
  const fromChat = type === "responses" && entry.proxy_from_chat_completions === true;
  if (fromChat) return proxyResponsesThroughChat(req, res, entry, original, metricTracker(type, entry));
  let target;
  try { target = makeTargetUrl(entry, type); } catch (e) { return res.status(500).json({ error: { message: e.message, type: "proxy_config_error" } }); }
  let body = getBodyBuffer(req);
  if (Object.keys(original).length) body = Buffer.from(JSON.stringify({ ...original, model: entry.upstream_model || publicModel }));
  sendUpstream(req, res, target, entry, body, null, metricTracker(type, entry));
}

function shellQuote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function logCurl(req, target, headers, body) {
  if (!String(req.originalUrl || "").startsWith("/api/test")) return;
  const parts = [`curl -i -X ${shellQuote(req.method || "POST")}`, shellQuote(target.href)];
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined || value === null) continue;
    const shown = key.toLowerCase() === "authorization" && !process.env.LOG_CURL_SECRETS ? String(value).replace(/Bearer\s+.+/i, "Bearer <redacted>") : value;
    parts.push(`-H ${shellQuote(`${key}: ${shown}`)}`);
  }
  if (body.length) parts.push(`--data-raw ${shellQuote(body.toString("utf8"))}`);
  console.log(`[api/test curl] ${parts.join(" ")}`);
}
function sendUpstream(req, res, target, entry, body, onResponse, tracker = null, attempt = 0) {
  const headers = {};
  // Forward only HTTP semantics needed by the upstream API. Passing Codex's
  // compression/client fingerprint headers through has caused some compatible
  // gateways to reset streaming tool requests before sending response headers.
  for (const key of ["content-type", "accept"]) {
    if (req.headers[key]) headers[key] = req.headers[key];
  }
  // Let the upstream choose its normal SSE/JSON representation; forwarding
  // Codex's `text/event-stream` Accept header can trigger resets on this CDN.
  headers.accept = "*/*";
  headers.host = target.host; headers["content-length"] = body.length;
  // Do not forward the downstream client's fingerprint. Some OpenAI-compatible
  // CDNs reset Node/Codex user agents on tool-bearing requests while accepting
  // the same HTTP/1.1 request with a conventional client user agent.
  headers["user-agent"] = process.env.UPSTREAM_USER_AGENT || "curl/8.0";
  if (entry.key) headers.authorization = `Bearer ${entry.key}`;
  logCurl(req, target, headers, body);
  const transport = target.protocol === "https:" ? https : http;
  const agent = entryUsesProxy(entry) ? new SocksProxyAgent(SOCKS5_PROXY) : undefined;
  const options = { protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), method: req.method, path: target.pathname + target.search, headers, lookup: (hostname, opts, callback) => dns.lookup(hostname, { ...opts, family: 4 }, callback), ...(agent ? { agent } : {}) };
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} model=${body.length ? safeModel(body) : ""} -> ${target.href} proxy=${entryUsesProxy(entry) ? "on" : "off"}`);
  const proxyReq = transport.request(options, (proxyRes) => {
    if (onResponse) return onResponse(proxyRes);
    if (tracker && String(proxyRes.headers["content-type"] || "").includes("text/event-stream")) {
      proxyRes.setEncoding("utf8");
      proxyRes.on("data", (chunk) => tracker.consume(chunk));
      proxyRes.on("end", () => tracker.finish(proxyRes.statusCode || 502));
    }
    res.status(proxyRes.statusCode || 502);
    for (const [key, value] of Object.entries(proxyRes.headers)) if (!hopByHop(key) && value !== undefined) res.setHeader(key, value);
    if (tracker && !String(proxyRes.headers["content-type"] || "").includes("text/event-stream")) { const chunks=[]; proxyRes.on("data",c=>chunks.push(c)); proxyRes.on("end",()=>{ const raw=Buffer.concat(chunks).toString("utf8"); let parsed=null; try { parsed=JSON.parse(raw); tracker.consumeJson(parsed); } catch {} tracker.finish(proxyRes.statusCode||502); res.end(raw); }); } else { proxyRes.pipe(res); }
  });
  proxyReq.setTimeout(Number(process.env.UPSTREAM_TIMEOUT || 120000), () => proxyReq.destroy(new Error("Upstream request timeout")));
  proxyReq.on("error", (err) => {
    // A few OpenAI-compatible HTTPS gateways occasionally reset the first
    // Node connection (especially for streamed tool requests) before headers
    // arrive. Retry once while the downstream response is still untouched.
    const retryable = !res.headersSent && attempt < 1 && ["ECONNRESET", "EPIPE", "ETIMEDOUT"].includes(err.code);
    if (retryable) {
      console.warn(`Upstream ${err.code}; retrying ${target.href}`);
      return sendUpstream(req, res, target, entry, body, onResponse, tracker, attempt + 1);
    }
    if (tracker) recordUsage(tracker.type,entry,tracker.startedEpoch,502,null);
    console.error("Proxy request error:", err.message);
    if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: "proxy_error" } }); else res.destroy(err);
  });
  if (body.length) proxyReq.write(body); proxyReq.end();
}
function safeModel(body) { try { return JSON.parse(body.toString("utf8")).model || ""; } catch { return ""; } }

function proxyResponsesThroughChat(req, res, entry, body, tracker = null) {
  console.log(`[responses request] ${req.method} ${req.originalUrl}`);
  console.log(JSON.stringify(body, null, 2));
  let chatBody;
  let requestMessages;
  let requestTools;
  let responseTools;
  try { ({ chat: chatBody, requestMessages, tools: requestTools, responseTools } = responseRequestToChat(body, responseState)); } catch (e) { return res.status(400).json({ error: { message: e.message, type: "invalid_request_error" } }); }
  chatBody.model = entry.upstream_model || body.model;
  const session = createResponseSession(body, chatBody, entry);
  if (body.stream && (!chatBody.stream_options || chatBody.stream_options.include_usage === undefined)) chatBody.stream_options = { ...(chatBody.stream_options || {}), include_usage: true };
  console.log(`[responses -> chat completions] ${req.method} ${entry.url}`);
  console.log(JSON.stringify(chatBody, null, 2));
  let target;
  try { target = makeTargetUrl(entry, "responses", true); } catch (e) { return res.status(500).json({ error: { message: e.message, type: "proxy_config_error" } }); }
  const payload = Buffer.from(JSON.stringify(chatBody));
  const isStream = body.stream === true;
  sendUpstream(req, res, target, entry, payload, (upstream) => {
    if (!isStream) {
      const chunks = [];
      upstream.on("data", (c) => chunks.push(c));
      upstream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let usage = null; let parsed = null; try { parsed = JSON.parse(raw); usage = parsed?.usage || null; tracker?.consumeJson?.(parsed); } catch {}
        if (tracker) tracker.finish(upstream.statusCode || 502); else recordUsage("responses", entry, Date.now(), upstream.statusCode || 502, usage);
        if ((upstream.statusCode || 500) >= 400) { let message = raw; try { message = JSON.parse(raw)?.error?.message || message; } catch {} return res.status(upstream.statusCode || 502).json({ error: { message, type: "upstream_error" } }); }
        try { const data = JSON.parse(raw); const response = chatToResponse(data, body.model, responseState, body.previous_response_id, requestMessages, requestTools, responseTools); updateResponseSession(session, { status: "completed", response_id: response.id, response }); res.status(200).json(response); } catch (e) { updateResponseSession(session, { status: "error", error: e.message }); res.status(502).json({ error: { message: e.message, type: "proxy_error" } }); }
      });
      return;
    }
    if ((upstream.statusCode || 500) >= 400) { updateResponseSession(session, { status: "error", upstream_status: upstream.statusCode }); res.status(upstream.statusCode || 502); upstream.pipe(res); return; }
    const responseId = `resp_${randomId()}`;
    const created = Math.floor(Date.now() / 1000);
    const previousMessages = body.previous_response_id && responseState[body.previous_response_id] && responseState[body.previous_response_id].messages ? responseState[body.previous_response_id].messages : [];
    const itemId = `msg_${randomId()}`;
    let fullText = "";
    let outputStarted = false;
    let finishReason = null;
    let streamUsage = null;
    const streamToolCalls = new Map();
    let nextOutputIndex = 0;
    res.status(200); res.setHeader("content-type", "text/event-stream"); res.setHeader("cache-control", "no-cache"); res.setHeader("connection", "keep-alive");
    let sequenceNumber = 0;
    let textOutputIndex = null;
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ ...data, sequence_number: sequenceNumber++ })}\n\n`);
    emit("response.created", { type: "response.created", response: { id: responseId, object: "response", created_at: created, status: "in_progress", model: body.model, output: [], previous_response_id: body.previous_response_id || null } });
    upstream.setEncoding("utf8");
    let buffer = "";
    upstream.on("data", (chunk) => {
      if (tracker) tracker.consume(chunk);
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") continue;
        let data; try { data = JSON.parse(raw); } catch { continue; }
        if (data.usage) streamUsage = data.usage;
        const choice = data.choices?.[0];
        finishReason = choice?.finish_reason || finishReason;
        const deltaObject = choice?.delta || {};
        for (const call of deltaObject.tool_calls || []) {
          const index = call.index ?? 0;
          const current = streamToolCalls.get(index) || { id: call.id || `call_${randomId()}`, itemId: `fc_${randomId()}`, outputIndex: nextOutputIndex++, name: "", arguments: "" };
          if (!streamToolCalls.has(index)) {
            streamToolCalls.set(index, current);
            emit("response.output_item.added", { type: "response.output_item.added", output_index: current.outputIndex, item: responseCallItem({ ...current, name: call.function?.name || "" }, responseTools, "in_progress") });
          }
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) {
            current.arguments += call.function.arguments;
            if (responseCallItem(current, responseTools, "in_progress").type === "function_call") emit("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: current.itemId, output_index: current.outputIndex, delta: call.function.arguments });
          }
          streamToolCalls.set(index, current);
        }
        const delta = deltaObject.content;
        if (delta) {
          if (!outputStarted) {
            outputStarted = true; textOutputIndex = nextOutputIndex++;
            emit("response.output_item.added", { type: "response.output_item.added", output_index: textOutputIndex, item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] } });
            emit("response.content_part.added", { type: "response.content_part.added", item_id: itemId, output_index: textOutputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          }
          fullText += delta;
          emit("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: textOutputIndex, content_index: 0, delta });
        }
      }
    });
    upstream.on("end", () => {
      let toolOutputs;
      try { toolOutputs = [...streamToolCalls.values()].map((call) => responseCallItem(call, responseTools)); }
      catch (e) { updateResponseSession(session, { status: "error", error: e.message }); emit("error", { type: "error", message: e.message }); res.end(); return; }
      for (const [index, call] of [...streamToolCalls.values()].entries()) {
        const item = toolOutputs[index];
        if (item.type === "custom_tool_call") {
          emit("response.custom_tool_call_input.delta", { type: "response.custom_tool_call_input.delta", item_id: call.itemId, output_index: call.outputIndex, delta: item.input });
          emit("response.custom_tool_call_input.done", { type: "response.custom_tool_call_input.done", item_id: call.itemId, output_index: call.outputIndex, input: item.input });
        } else emit("response.function_call_arguments.done", { type: "response.function_call_arguments.done", item_id: call.itemId, output_index: call.outputIndex, name: call.name, arguments: call.arguments });
        emit("response.output_item.done", { type: "response.output_item.done", output_index: call.outputIndex, item });
      }
      const messages = [...previousMessages, ...requestMessages];
      if (outputStarted || fullText || toolOutputs.length) {
        const assistant = { role: "assistant", content: fullText };
        if (streamToolCalls.size) assistant.tool_calls = [...streamToolCalls.values()].map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
        messages.push(assistant);
      }
      responseState[responseId] = { messages, tools: requestTools, created_at: created }; saveResponseState();
      const completedStatus = finishReason === "length" ? "incomplete" : "completed";
      updateResponseSession(session, { status: completedStatus, response_id: responseId, response: { id: responseId, output_text: fullText, usage: responseUsage(streamUsage) } });
      if (outputStarted) {
        const part = { type: "output_text", text: fullText, annotations: [] };
        emit("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: textOutputIndex, content_index: 0, text: fullText });
        emit("response.content_part.done", { type: "response.content_part.done", item_id: itemId, output_index: textOutputIndex, content_index: 0, part });
        emit("response.output_item.done", { type: "response.output_item.done", output_index: textOutputIndex, item: { id: itemId, type: "message", role: "assistant", status: completedStatus, content: [part] } });
      }
      emit("response.completed", { type: "response.completed", response: { id: responseId, object: "response", created_at: created, status: completedStatus, model: body.model, output: [...(fullText || outputStarted ? [{ id: itemId, type: "message", role: "assistant", status: completedStatus, content: [{ type: "output_text", text: fullText, annotations: [] }] }] : []), ...toolOutputs], previous_response_id: body.previous_response_id || null, output_text: fullText, incomplete_details: finishReason === "length" ? { reason: "max_output_tokens" } : null, usage: responseUsage(streamUsage), tools: responseToolsForResponse(responseTools) } });
      if (tracker) tracker.finish(200);
      res.end();
    });
    upstream.on("error", (e) => { if (tracker) tracker.finish(502); emit("error", { type: "error", error: { message: e.message, type: "proxy_error" } }); res.end(); });
  });
}

const BENCHMARK_PROMPT = "请用中文写一段约两百字的完整回复，主题是“为什么人工智能值得学习”。只输出正文，不要标题、列表、Markdown、前言或结语说明。请尽量接近两百字。";
function parseSseLines(buffer, onData) {
  const lines = buffer.split(/\r?\n/);
  return { rest: lines.pop() || "", done: lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).filter(Boolean).map((raw) => { try { return JSON.parse(raw); } catch { return null; } }).filter(Boolean).map(onData) };
}
function extractTestText(raw, type) {
  try {
    const data = JSON.parse(raw);
    if (type === "responses") {
      const responseText = data.output_text || data.output?.flatMap((x) => x.content || []).filter((x) => x.type === "output_text").map((x) => x.text || "").join("") || "";
      if (responseText) return responseText;
      // /api/test for a Responses entry configured to proxy through Chat Completions
      // receives the upstream Chat Completions JSON before it is wrapped as a Response.
      const content = data.choices?.[0]?.message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
      return data.choices?.[0]?.text || "";
    }
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((part) => part?.text || "").join("");
    return data.choices?.[0]?.text || "";
  } catch { return raw; }
}
function performTest(entry, type) {
  const originalBody = type === "responses" ? { model: entry.upstream_model || entry.public_model, input: "你好" } : { model: entry.upstream_model || entry.public_model, messages: [{ role: "user", content: "你好" }] };
  const fromChat = type === "responses" && entry.proxy_from_chat_completions === true;
  let body = originalBody;
  let target;
  try {
    if (fromChat) {
      body = responseRequestToChat(originalBody, responseState).chat;
      body.model = entry.upstream_model || originalBody.model;
      target = makeTargetUrl(entry, "responses", true);
    } else target = makeTargetUrl(entry, type);
  } catch (e) { return Promise.reject(e); }
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const fakeReq = { method: "POST", headers: { "content-type": "application/json" }, originalUrl: `/api/test/${type}` };
    const fakeRes = { headersSent: false, statusCode: 200, status() { return this; }, setHeader() {}, json(value) { reject(new Error(value?.error?.message || "test failed")); }, destroy(err) { reject(err); } };
    sendUpstream(fakeReq, { ...fakeRes, status(code) { this.statusCode = code; return this; } }, target, entry, payload, (upstream) => {
      const chunks = [];
      upstream.on("data", (chunk) => chunks.push(chunk));
      upstream.on("end", () => resolve({ status: upstream.statusCode || 502, body: Buffer.concat(chunks).toString("utf8") }));
      upstream.on("error", reject);
    });
  });
}
async function runAllBenchmarks() {
  const results = [];
  for (const type of ["chat_completions", "responses"]) for (const entry of config[type] || []) if (entry.enabled !== false && entry.public_model && entry.url) {
    try { results.push({ type, model: entry.public_model, upstream_model: entry.upstream_model || entry.public_model, ...(await benchmarkEntry(entry, type)) }); }
    catch (e) { results.push({ type, model: entry.public_model, upstream_model: entry.upstream_model || entry.public_model, ok: false, error: e.message }); }
  }
  return results;
}
function benchmarkEntry(entry, type) {
  const startedAt = Date.now();
  const body = type === "responses" ? { model: entry.upstream_model || entry.public_model, input: BENCHMARK_PROMPT, stream: true, max_output_tokens: 500 } : { model: entry.upstream_model || entry.public_model, messages: [{ role: "user", content: BENCHMARK_PROMPT }], stream: true, max_tokens: 500 };
  return new Promise((resolve, reject) => {
    let target; try { target = makeTargetUrl(entry, type); } catch (e) { reject(e); return; }
    const payload = Buffer.from(JSON.stringify(body));
    const fakeReq = { method: "POST", headers: { "content-type": "application/json", accept: "text/event-stream" }, originalUrl: `/api/test-all/${type}` };
    sendUpstream(fakeReq, { headersSent: false, status() { return this; }, setHeader() {}, json() {}, destroy() {} }, target, entry, payload, (upstream) => {
      if ((upstream.statusCode || 500) >= 400) { reject(new Error(`HTTP ${upstream.statusCode}`)); return; }
      let firstTextAt = null, text = "", usage = null, buffer = "";
      upstream.setEncoding("utf8");
      upstream.on("data", (chunk) => { buffer += chunk; const parsed = parseSseLines(buffer, (data) => { if (data.usage) usage = data.usage; const delta = type === "responses" ? (typeof data.delta === "string" ? data.delta : "") : (data.choices?.[0]?.delta?.content || ""); if (delta) { if (firstTextAt === null) firstTextAt = Date.now(); text += delta; } }); buffer = parsed.rest; });
      upstream.on("end", () => { const ended = Date.now(); const generationMs = firstTextAt === null ? null : ended - firstTextAt; const chars = [...text].length; const tokens = usage?.completion_tokens ?? usage?.output_tokens ?? null; resolve({ ok: true, status: upstream.statusCode, ttft_ms: firstTextAt === null ? null : firstTextAt - startedAt, total_ms: ended - startedAt, generated_chars: chars, completion_tokens: tokens, chars_per_second: generationMs && chars ? Math.round(chars / (generationMs / 1000) * 10) / 10 : null, tokens_per_second: tokens != null && generationMs > 0 ? Math.round(tokens / (generationMs / 1000) * 10) / 10 : null, text }); });
      upstream.on("error", reject);
    });
  });
}

app.all("/v1/chat/completions", (req, res) => proxyRequest(req, res, "chat_completions"));
app.all("/v1/responses", (req, res) => proxyRequest(req, res, "responses"));
app.get("/v1/models", (req, res) => {
  const models = new Map();
  for (const type of ["chat_completions", "responses"]) for (const entry of (config[type] || [])) if (entry.enabled !== false && entry.public_model && !models.has(entry.public_model)) models.set(entry.public_model, { id: entry.public_model, object: "model", created: Number(entry.created) || 0, owned_by: entry.owned_by || "llm-proxy" });
  res.json({ object: "list", data: [...models.values()] });
});
app.get("/api/config", (req, res) => res.json(sanitizeConfig()));
app.get("/api/usage", (req, res) => res.json(publicUsage()));
app.get("/api/response-sessions", (req, res) => res.json(responseSessions.slice().reverse()));
app.get("/api/metrics", (req, res) => { const result = {}; for (const type of ["chat_completions", "responses"]) result[type] = (config[type] || []).map((entry) => ({ id: entry.id, public_model: entry.public_model, upstream_model: entry.upstream_model || entry.public_model, samples: metrics[metricKey(type, entry)] || [] })); res.json(result); });
app.put("/api/config", (req, res) => { const incoming = req.body || {}; for (const type of ["chat_completions", "responses"]) { if (!Array.isArray(incoming[type])) continue; config[type] = incoming[type].map((x) => ({ id: String(x.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`), public_model: String(x.public_model || "").trim(), url: String(x.url || "").trim(), key: x.key === "********" ? ((config[type] || []).find((old) => old.id === x.id)?.key || "") : String(x.key || ""), upstream_model: String(x.upstream_model || "").trim(), use_proxy: x.use_proxy !== false, proxy_from_chat_completions: type === "responses" ? x.proxy_from_chat_completions === true : false, cache_price: numberOrNull(x.cache_price) ?? 0, prefill_price: numberOrNull(x.prefill_price) ?? 0, generation_price: numberOrNull(x.generation_price) ?? 0, enabled: x.enabled !== false })).filter((x) => x.public_model && x.url); } saveConfig(config); res.json(sanitizeConfig()); });
app.post("/api/test", async (req, res) => { const type = req.body?.type, id = req.body?.id; if (!["chat_completions", "responses"].includes(type) || !id) return res.status(400).json({ ok: false, error: "Invalid test request" }); const entry = (config[type] || []).find((x) => x.id === id); if (!entry) return res.status(404).json({ ok: false, error: "Upstream not found" }); try { const result = await performTest(entry, type); res.json({ ok: true, status: result.status, text: extractTestText(result.body, type), raw: result.body }); } catch (e) { res.status(502).json({ ok: false, error: e.message }); } });
app.post("/api/test-all", async (req, res) => { try { const results = await runAllBenchmarks(); res.json({ ok: true, prompt: BENCHMARK_PROMPT, results }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => { const distIndex = path.join(__dirname, "dist", "index.html"); const sourceIndex = path.join(__dirname, "index.html"); res.sendFile(fs.existsSync(distIndex) ? distIndex : sourceIndex); });
const server = app.listen(
  LISTEN_PORT,
  LISTEN_HOST,
  () => console.log(`LLM Proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`)
);

server.on("error", (err) => {
  console.error(
    `Failed to listen on http://${LISTEN_HOST}:${LISTEN_PORT}:`,
    err
  );
  process.exit(1);
});
