const express = require("express");
const http = require("http");
const https = require("https");
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
  let firstTextAt = null, text = "", usage = null, buffer = "";
  const consume = (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") continue;
      let data; try { data = JSON.parse(raw); } catch { continue; }
      if (data.usage) usage = data.usage;
      const delta = typeof data.delta === "string" ? data.delta : (data.choices?.[0]?.delta?.content || data.output_text?.delta || "");
      if (!delta) continue;
      if (firstTextAt === null) firstTextAt = process.hrtime.bigint();
      text += delta;
    }
  };
  return { type, entry, startedEpoch, consume, finish(status) {
    consume("");
    recordUsage(type, entry, startedEpoch, status, usage);
    if (firstTextAt === null) return;
    const finishedAt = process.hrtime.bigint();
    const ttftMs = Number(firstTextAt - startedAt) / 1e6;
    const generationMs = Number(finishedAt - firstTextAt) / 1e6;
    const tokens = usage?.completion_tokens ?? usage?.output_tokens ?? null;
    const chars = [...text].length;
    recordMetric(type, entry, { status, ttft_ms: Math.round(ttftMs), tokens_per_second: tokens != null && generationMs > 0 ? Math.round(tokens / (generationMs / 1000) * 10) / 10 : null, chars_per_second: chars && generationMs > 0 ? Math.round(chars / (generationMs / 1000) * 10) / 10 : null, completion_tokens: tokens, generated_chars: chars });
  } };
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
    if (item.type === "function_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "") });
      continue;
    }
    if (item.type === "function_call") {
      messages.push({ role: "assistant", tool_calls: [{ id: item.call_id || item.id, type: "function", function: { name: item.name, arguments: item.arguments || "" } }] });
      continue;
    }
    const role = item.role || (item.type === "message" ? "user" : "user");
    const content = responseContentToChat(item.content ?? item.text ?? "");
    if ((typeof content === "string" && content !== "") || (Array.isArray(content) && content.length)) messages.push({ role, content });
  }
  return messages;
}
function responseRequestToChat(body, state) {
  const currentMessages = [];
  if (body.instructions) currentMessages.push({ role: "system", content: responseContentToChat(body.instructions) });
  let messages = [...currentMessages];
  if (body.previous_response_id) {
    const previous = state[body.previous_response_id];
    if (!previous) throw new Error(`Unknown previous_response_id: ${body.previous_response_id}`);
    messages = [...previous.messages, ...currentMessages];
  }
  const requestMessages = responseInputToMessages(body.input);
  currentMessages.push(...requestMessages);
  messages.push(...requestMessages);
  const chat = { model: body.model, messages };
  const allowed = ["temperature", "top_p", "stream", "stop", "presence_penalty", "frequency_penalty", "seed", "response_format", "logprobs", "top_logprobs", "n"];
  for (const key of allowed) if (body[key] !== undefined) chat[key] = body[key];
  if (body.max_output_tokens != null) chat.max_completion_tokens = body.max_output_tokens;
  if (body.max_tokens != null) chat.max_tokens = body.max_tokens;
  if (Array.isArray(body.tools)) chat.tools = body.tools.filter((x) => x.type === "function").map((x) => ({ type: "function", function: { name: x.name || x.function?.name, description: x.description || x.function?.description, parameters: x.parameters || x.function?.parameters } }));
  if (body.tool_choice !== undefined) {
    chat.tool_choice = body.tool_choice === "function" ? "required" : body.tool_choice;
    if (body.tool_choice?.type === "function") chat.tool_choice = { type: "function", function: { name: body.tool_choice.name || body.tool_choice.function?.name } };
  }
  return { chat, requestMessages: currentMessages };
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
function chatMessageToResponseOutput(message) {
  const content = message?.content;
  const output = [{ id: `msg_${randomId()}`, type: "message", role: "assistant", status: "completed", content: [] }];
  if (typeof content === "string" && content) output[0].content.push({ type: "output_text", text: content, annotations: [] });
  else if (Array.isArray(content)) for (const part of content) if (part?.text) output[0].content.push({ type: "output_text", text: part.text, annotations: [] });
  if (message?.tool_calls?.length) for (const call of message.tool_calls) {
    const callId = call.id || `call_${randomId()}`;
    output.push({ id: `fc_${randomId()}`, type: "function_call", status: "completed", name: call.function?.name, arguments: call.function?.arguments || "", call_id: callId });
  }
  return output;
}
function randomId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function chatToResponse(data, publicModel, state, previousId, requestMessages = []) {
  const id = `resp_${randomId()}`;
  const message = data.choices?.[0]?.message || { role: "assistant", content: "" };
  const output = chatMessageToResponseOutput(message);
  const assistantMessages = [chatAssistantMessageToHistory(message)];
  state[id] = { messages: [...(previousId && state[previousId] ? state[previousId].messages : []), ...requestMessages, ...assistantMessages], created_at: Math.floor(Date.now() / 1000) };
  saveResponseState();
  const text = output.flatMap((x) => x.content || []).filter((x) => x.type === "output_text").map((x) => x.text).join("");
  return { id, object: "response", created_at: state[id].created_at, status: "completed", error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model: publicModel, output, parallel_tool_calls: true, previous_response_id: previousId || null, reasoning: { effort: null, summary: null }, service_tier: null, store: true, temperature: data.temperature ?? null, text: { format: { type: "text" } }, tool_choice: data.tool_choice || "auto", tools: data.tools || [], top_p: data.top_p ?? null, truncation: "disabled", usage: responseUsage(data.usage), metadata: {}, output_text: text };
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
function sendUpstream(req, res, target, entry, body, onResponse, tracker = null) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) if (!hopByHop(key)) headers[key] = value;
  headers.host = target.host; headers["content-length"] = body.length;
  if (entry.key) headers.authorization = `Bearer ${entry.key}`;
  logCurl(req, target, headers, body);
  const transport = target.protocol === "https:" ? https : http;
  const agent = entryUsesProxy(entry) ? new SocksProxyAgent(SOCKS5_PROXY) : undefined;
  const options = { protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), method: req.method, path: target.pathname + target.search, headers, ...(agent ? { agent } : {}) };
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
    if (tracker && !String(proxyRes.headers["content-type"] || "").includes("text/event-stream")) { const chunks=[]; proxyRes.on("data",c=>chunks.push(c)); proxyRes.on("end",()=>{ const raw=Buffer.concat(chunks).toString("utf8"); let usage=null; try { usage=JSON.parse(raw)?.usage||null; } catch {} recordUsage(tracker.type,entry,tracker.startedEpoch,proxyRes.statusCode||502,usage); res.end(raw); }); } else { proxyRes.pipe(res); }
  });
  proxyReq.setTimeout(Number(process.env.UPSTREAM_TIMEOUT || 120000), () => proxyReq.destroy(new Error("Upstream request timeout")));
  proxyReq.on("error", (err) => { if (tracker) recordUsage(tracker.type,entry,tracker.startedEpoch,502,null); console.error("Proxy request error:", err.message); if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: "proxy_error" } }); else res.destroy(err); });
  if (body.length) proxyReq.write(body); proxyReq.end();
}
function safeModel(body) { try { return JSON.parse(body.toString("utf8")).model || ""; } catch { return ""; } }

function proxyResponsesThroughChat(req, res, entry, body, tracker = null) {
  let chatBody;
  let requestMessages;
  try { ({ chat: chatBody, requestMessages } = responseRequestToChat(body, responseState)); } catch (e) { return res.status(400).json({ error: { message: e.message, type: "invalid_request_error" } }); }
  chatBody.model = entry.upstream_model || body.model;
  if (body.stream && (!chatBody.stream_options || chatBody.stream_options.include_usage === undefined)) chatBody.stream_options = { ...(chatBody.stream_options || {}), include_usage: true };
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
        let usage = null; try { usage = JSON.parse(raw)?.usage || null; } catch {}
        recordUsage("responses", entry, tracker?.startedEpoch || Date.now(), upstream.statusCode || 502, usage);
        if ((upstream.statusCode || 500) >= 400) { let message = raw; try { message = JSON.parse(raw)?.error?.message || message; } catch {} return res.status(upstream.statusCode || 502).json({ error: { message, type: "upstream_error" } }); }
        try { const data = JSON.parse(raw); const response = chatToResponse(data, body.model, responseState, body.previous_response_id, requestMessages); res.status(200).json(response); } catch (e) { res.status(502).json({ error: { message: e.message, type: "proxy_error" } }); }
      });
      return;
    }
    if ((upstream.statusCode || 500) >= 400) { res.status(upstream.statusCode || 502); upstream.pipe(res); return; }
    const responseId = `resp_${randomId()}`;
    const created = Math.floor(Date.now() / 1000);
    const previousMessages = body.previous_response_id && responseState[body.previous_response_id] && responseState[body.previous_response_id].messages ? responseState[body.previous_response_id].messages : [];
    const itemId = `msg_${randomId()}`;
    let fullText = "";
    let outputStarted = false;
    let finishReason = null;
    let streamUsage = null;
    const streamToolCalls = new Map();
    res.status(200); res.setHeader("content-type", "text/event-stream"); res.setHeader("cache-control", "no-cache"); res.setHeader("connection", "keep-alive");
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
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
          const current = streamToolCalls.get(index) || { id: call.id || `call_${randomId()}`, name: "", arguments: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.arguments += call.function.arguments;
          streamToolCalls.set(index, current);
        }
        const delta = deltaObject.content;
        if (delta) { if (!outputStarted) { outputStarted = true; emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] } }); } fullText += delta; emit("response.output_text.delta", { type: "response.output_text.delta", item_id: itemId, output_index: 0, content_index: 0, delta }); }
      }
    });
    upstream.on("end", () => {
      const toolOutputs = [...streamToolCalls.values()].map((call) => ({ id: `fc_${randomId()}`, type: "function_call", status: "completed", name: call.name, arguments: call.arguments, call_id: call.id }));
      for (const item of toolOutputs) emit("response.output_item.done", { type: "response.output_item.done", output_index: 1, item });
      const messages = [...previousMessages, ...requestMessages];
      if (outputStarted || fullText || toolOutputs.length) {
        const assistant = { role: "assistant", content: fullText };
        if (streamToolCalls.size) assistant.tool_calls = [...streamToolCalls.values()].map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }));
        messages.push(assistant);
      }
      responseState[responseId] = { messages, created_at: created }; saveResponseState();
      if (outputStarted) emit("response.output_text.done", { type: "response.output_text.done", item_id: itemId, output_index: 0, content_index: 0, text: fullText });
      const completedStatus = finishReason === "length" ? "incomplete" : "completed";
      emit("response.completed", { type: "response.completed", response: { id: responseId, object: "response", created_at: created, status: completedStatus, model: body.model, output: [...(fullText || outputStarted ? [{ id: itemId, type: "message", role: "assistant", status: completedStatus, content: [{ type: "output_text", text: fullText, annotations: [] }] }] : []), ...toolOutputs], previous_response_id: body.previous_response_id || null, output_text: fullText, incomplete_details: finishReason === "length" ? { reason: "max_output_tokens" } : null, usage: responseUsage(streamUsage) } });
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
app.get("/api/metrics", (req, res) => { const result = {}; for (const type of ["chat_completions", "responses"]) result[type] = (config[type] || []).map((entry) => ({ id: entry.id, public_model: entry.public_model, upstream_model: entry.upstream_model || entry.public_model, samples: metrics[metricKey(type, entry)] || [] })); res.json(result); });
app.put("/api/config", (req, res) => { const incoming = req.body || {}; for (const type of ["chat_completions", "responses"]) { if (!Array.isArray(incoming[type])) continue; config[type] = incoming[type].map((x) => ({ id: String(x.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`), public_model: String(x.public_model || "").trim(), url: String(x.url || "").trim(), key: x.key === "********" ? ((config[type] || []).find((old) => old.id === x.id)?.key || "") : String(x.key || ""), upstream_model: String(x.upstream_model || "").trim(), use_proxy: x.use_proxy !== false, proxy_from_chat_completions: type === "responses" ? x.proxy_from_chat_completions === true : false, cache_price: numberOrNull(x.cache_price) ?? 0, prefill_price: numberOrNull(x.prefill_price) ?? 0, generation_price: numberOrNull(x.generation_price) ?? 0, enabled: x.enabled !== false })).filter((x) => x.public_model && x.url); } saveConfig(config); res.json(sanitizeConfig()); });
app.post("/api/test", async (req, res) => { const type = req.body?.type, id = req.body?.id; if (!["chat_completions", "responses"].includes(type) || !id) return res.status(400).json({ ok: false, error: "Invalid test request" }); const entry = (config[type] || []).find((x) => x.id === id); if (!entry) return res.status(404).json({ ok: false, error: "Upstream not found" }); try { const result = await performTest(entry, type); res.json({ ok: true, status: result.status, text: extractTestText(result.body, type), raw: result.body }); } catch (e) { res.status(502).json({ ok: false, error: e.message }); } });
app.post("/api/test-all", async (req, res) => { try { const results = await runAllBenchmarks(); res.json({ ok: true, prompt: BENCHMARK_PROMPT, results }); } catch (e) { res.status(500).json({ ok: false, error: e.message }); } });
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => { const distIndex = path.join(__dirname, "dist", "index.html"); const sourceIndex = path.join(__dirname, "index.html"); res.sendFile(fs.existsSync(distIndex) ? distIndex : sourceIndex); });
app.listen(LISTEN_PORT, LISTEN_HOST, () => console.log(`LLM Proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`));
