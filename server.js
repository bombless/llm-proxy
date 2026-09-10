const express = require("express");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { SocksProxyAgent } = require("socks-proxy-agent");

const LISTEN_HOST = process.env.LISTEN_HOST || "127.0.0.1";
const LISTEN_PORT = Number(process.env.LISTEN_PORT || 8080);
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || "";
const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, "config.json");
const RESPONSE_STATE_FILE = process.env.RESPONSE_STATE_FILE || path.join(__dirname, "responses-state.json");

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

function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((x) => typeof x === "string" ? x : (x.text || "")).join("");
}
function responseInputToMessages(input) {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) return [];
  return input.map((item) => {
    if (typeof item === "string") return { role: "user", content: item };
    const role = item.role || (item.type === "message" ? "user" : "user");
    if (item.type === "message") return { role, content: normalizeContent(item.content) };
    if (item.type === "input_text") return { role: "user", content: item.text || "" };
    if (item.type === "output_text") return { role: "assistant", content: item.text || "" };
    return { role, content: normalizeContent(item.content || item.text || "") };
  }).filter((x) => x.content !== "");
}
function responseRequestToChat(body, state) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: normalizeContent(body.instructions) });
  if (body.previous_response_id) {
    const previous = state[body.previous_response_id];
    if (!previous) throw new Error(`Unknown previous_response_id: ${body.previous_response_id}`);
    messages.push(...previous.messages);
  }
  messages.push(...responseInputToMessages(body.input));
  const chat = { ...body, model: body.model, messages };
  delete chat.input; delete chat.instructions; delete chat.previous_response_id; delete chat.max_output_tokens;
  if (body.max_output_tokens != null) chat.max_tokens = body.max_output_tokens;
  delete chat.store; delete chat.background; delete chat.include; delete chat.service_tier; delete chat.prompt_cache_key;
  if (Array.isArray(body.tools)) chat.tools = body.tools.filter((x) => x.type === "function").map((x) => ({ type: "function", function: { name: x.name || x.function?.name, description: x.description || x.function?.description, parameters: x.parameters || x.function?.parameters } }));
  if (body.tool_choice && body.tool_choice.type === "function") chat.tool_choice = { type: "function", function: { name: body.tool_choice.name || body.tool_choice.function?.name } };
  return chat;
}
function chatMessageToResponseOutput(message) {
  const content = message?.content;
  const output = [{ id: `msg_${randomId()}`, type: "message", role: "assistant", status: "completed", content: [] }];
  if (typeof content === "string" && content) output[0].content.push({ type: "output_text", text: content, annotations: [] });
  else if (Array.isArray(content)) for (const part of content) if (part.text) output[0].content.push({ type: "output_text", text: part.text, annotations: [] });
  if (message?.tool_calls?.length) for (const call of message.tool_calls) output.push({ id: call.id || `fc_${randomId()}`, type: "function_call", status: "completed", name: call.function?.name, arguments: call.function?.arguments || "", call_id: call.id || `call_${randomId()}` });
  return output;
}
function randomId() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }
function chatToResponse(data, publicModel, state, previousId) {
  const id = `resp_${randomId()}`;
  const message = data.choices?.[0]?.message || { role: "assistant", content: "" };
  const output = chatMessageToResponseOutput(message);
  const assistantMessages = [{ role: "assistant", content: normalizeContent(message.content) }];
  state[id] = { messages: [...(previousId && state[previousId] ? state[previousId].messages : []), ...assistantMessages], created_at: Math.floor(Date.now() / 1000) };
  saveResponseState();
  const text = output.flatMap((x) => x.content || []).filter((x) => x.type === "output_text").map((x) => x.text).join("");
  return { id, object: "response", created_at: state[id].created_at, status: "completed", error: null, incomplete_details: null, instructions: null, max_output_tokens: null, model: publicModel, output, parallel_tool_calls: true, previous_response_id: previousId || null, reasoning: { effort: null, summary: null }, service_tier: null, store: true, temperature: data.temperature ?? null, text: { format: { type: "text" } }, tool_choice: data.tool_choice || "auto", tools: data.tools || [], top_p: data.top_p ?? null, truncation: "disabled", usage: data.usage || null, user: null, metadata: {}, output_text: text };
}

function proxyRequest(req, res, type) {
  const original = getBodyObject(req);
  const publicModel = original.model;
  const entry = upstreamFor(type, publicModel);
  if (!entry) return res.status(404).json({ error: { message: `No upstream configured for model: ${publicModel || "(missing)"}`, type: "model_not_configured" } });
  const fromChat = type === "responses" && entry.proxy_from_chat_completions === true;
  if (fromChat) return proxyResponsesThroughChat(req, res, entry, original);
  let target;
  try { target = makeTargetUrl(entry, type); } catch (e) { return res.status(500).json({ error: { message: e.message, type: "proxy_config_error" } }); }
  let body = getBodyBuffer(req);
  if (Object.keys(original).length) body = Buffer.from(JSON.stringify({ ...original, model: entry.upstream_model || publicModel }));
  sendUpstream(req, res, target, entry, body);
}

function sendUpstream(req, res, target, entry, body, onResponse) {
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) if (!hopByHop(key)) headers[key] = value;
  headers.host = target.host; headers["content-length"] = body.length;
  if (entry.key) headers.authorization = `Bearer ${entry.key}`;
  const transport = target.protocol === "https:" ? https : http;
  const agent = entryUsesProxy(entry) ? new SocksProxyAgent(SOCKS5_PROXY) : undefined;
  const options = { protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), method: req.method, path: target.pathname + target.search, headers, ...(agent ? { agent } : {}) };
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} model=${body.length ? safeModel(body) : ""} -> ${target.href} proxy=${entryUsesProxy(entry) ? "on" : "off"}`);
  const proxyReq = transport.request(options, (proxyRes) => {
    if (onResponse) return onResponse(proxyRes);
    res.status(proxyRes.statusCode || 502);
    for (const [key, value] of Object.entries(proxyRes.headers)) if (!hopByHop(key) && value !== undefined) res.setHeader(key, value);
    proxyRes.pipe(res);
  });
  proxyReq.setTimeout(Number(process.env.UPSTREAM_TIMEOUT || 120000), () => proxyReq.destroy(new Error("Upstream request timeout")));
  proxyReq.on("error", (err) => { console.error("Proxy request error:", err.message); if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: "proxy_error" } }); else res.destroy(err); });
  if (body.length) proxyReq.write(body); proxyReq.end();
}
function safeModel(body) { try { return JSON.parse(body.toString("utf8")).model || ""; } catch { return ""; } }

function proxyResponsesThroughChat(req, res, entry, body) {
  let chatBody;
  try { chatBody = responseRequestToChat(body, responseState); } catch (e) { return res.status(400).json({ error: { message: e.message, type: "invalid_request_error" } }); }
  chatBody.model = entry.upstream_model || body.model;
  const target = (() => { try { return makeTargetUrl(entry, "responses", true); } catch (e) { throw e; } })();
  const payload = Buffer.from(JSON.stringify(chatBody));
  const isStream = body.stream === true;
  sendUpstream(req, res, target, entry, payload, (upstream) => {
    if (!isStream) {
      const chunks = [];
      upstream.on("data", (c) => chunks.push(c));
      upstream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if ((upstream.statusCode || 500) >= 400) { let message = raw; try { message = JSON.parse(raw)?.error?.message || message; } catch {} return res.status(upstream.statusCode || 502).json({ error: { message, type: "upstream_error" } }); }
        try { const data = JSON.parse(raw); const response = chatToResponse(data, body.model, responseState, body.previous_response_id); res.status(200).json(response); } catch (e) { res.status(502).json({ error: { message: e.message, type: "proxy_error" } }); }
      });
      return;
    }
    if ((upstream.statusCode || 500) >= 400) { res.status(upstream.statusCode || 502); upstream.pipe(res); return; }
    const responseId = `resp_${randomId()}`;
    const created = Math.floor(Date.now() / 1000);
    const previousMessages = body.previous_response_id && responseState[body.previous_response_id] ? responseState[body.previous_response_id].messages : [];
    let fullText = "";
    let outputStarted = false;
    res.status(200); res.setHeader("content-type", "text/event-stream"); res.setHeader("cache-control", "no-cache"); res.setHeader("connection", "keep-alive");
    const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    emit("response.created", { type: "response.created", response: { id: responseId, object: "response", created_at: created, status: "in_progress", model: body.model, output: [], previous_response_id: body.previous_response_id || null } });
    upstream.setEncoding("utf8");
    let buffer = "";
    upstream.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim(); if (!raw || raw === "[DONE]") continue;
        let data; try { data = JSON.parse(raw); } catch { continue; }
        const delta = data.choices?.[0]?.delta?.content;
        if (delta) { if (!outputStarted) { outputStarted = true; emit("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { id: `msg_${randomId()}`, type: "message", role: "assistant", status: "in_progress", content: [] } }); } fullText += delta; emit("response.output_text.delta", { type: "response.output_text.delta", item_id: "", output_index: 0, content_index: 0, delta }); }
      }
    });
    upstream.on("end", () => {
      const messages = [...previousMessages, { role: "assistant", content: fullText }];
      responseState[responseId] = { messages, created_at: created }; saveResponseState();
      if (outputStarted) emit("response.output_text.done", { type: "response.output_text.done", item_id: "", output_index: 0, content_index: 0, text: fullText });
      emit("response.completed", { type: "response.completed", response: { id: responseId, object: "response", created_at: created, status: "completed", model: body.model, output: [{ id: `msg_${randomId()}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText, annotations: [] }] }], previous_response_id: body.previous_response_id || null, output_text: fullText } });
      res.end();
    });
    upstream.on("error", (e) => { emit("error", { type: "error", error: { message: e.message, type: "proxy_error" } }); res.end(); });
  });
}

async function performTest(entry, type) {
  return new Promise((resolve, reject) => {
    let target; try { target = makeTargetUrl(entry, type, type === "responses" && entry.proxy_from_chat_completions === true); } catch (e) { reject(e); return; }
    const model = entry.upstream_model || entry.public_model;
    const body = type === "responses" ? { model, input: "你好" } : { model, messages: [{ role: "user", content: "你好" }] };
    const payload = Buffer.from(JSON.stringify(entry.proxy_from_chat_completions && type === "responses" ? responseRequestToChat(body, responseState) : body));
    const headers = { host: target.host, "content-type": "application/json", "content-length": payload.length };
    if (entry.key) headers.authorization = `Bearer ${entry.key}`;
    const transport = target.protocol === "https:" ? https : http;
    const agent = entryUsesProxy(entry) ? new SocksProxyAgent(SOCKS5_PROXY) : undefined;
    const options = { protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), method: "POST", path: target.pathname + target.search, headers, ...(agent ? { agent } : {}) };
    const request = transport.request(options, (response) => { const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); if ((response.statusCode || 500) >= 400) { let message = raw; try { message = JSON.parse(raw)?.error?.message || message; } catch {} reject(new Error(`HTTP ${response.statusCode}: ${message}`)); return; } resolve({ status: response.statusCode || 200, body: raw }); }); response.on("error", reject); });
    request.setTimeout(Number(process.env.UPSTREAM_TIMEOUT || 120000), () => request.destroy(new Error("Upstream request timeout"))); request.on("error", reject); request.end(payload);
  });
}
function extractTestText(raw, type) { try { const data = JSON.parse(raw); if (type === "responses") { if (typeof data.output_text === "string") return data.output_text; return (data.output || []).flatMap((x) => x.content || []).filter((x) => x.text).map((x) => x.text).join("") || JSON.stringify(data, null, 2); } const content = data.choices?.[0]?.message?.content; return typeof content === "string" ? content : JSON.stringify(data, null, 2); } catch { return raw; } }

app.all("/v1/chat/completions", (req, res) => proxyRequest(req, res, "chat_completions"));
app.all("/v1/responses", (req, res) => proxyRequest(req, res, "responses"));
app.get("/v1/models", (req, res) => {
  const models = new Map();
  for (const type of ["chat_completions", "responses"]) {
    for (const entry of (config[type] || [])) {
      if (entry.enabled === false || !entry.public_model) continue;
      if (!models.has(entry.public_model)) {
        models.set(entry.public_model, {
          id: entry.public_model,
          object: "model",
          created: Number(entry.created) || 0,
          owned_by: entry.owned_by || "llm-proxy"
        });
      }
    }
  }
  res.json({ object: "list", data: [...models.values()] });
});
app.get("/api/config", (req, res) => res.json(sanitizeConfig()));
app.put("/api/config", (req, res) => { const incoming = req.body || {}; for (const type of ["chat_completions", "responses"]) { if (!Array.isArray(incoming[type])) continue; config[type] = incoming[type].map((x) => ({ id: String(x.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`), public_model: String(x.public_model || "").trim(), url: String(x.url || "").trim(), key: x.key === "********" ? ((config[type] || []).find((old) => old.id === x.id)?.key || "") : String(x.key || ""), upstream_model: String(x.upstream_model || "").trim(), use_proxy: x.use_proxy !== false, proxy_from_chat_completions: type === "responses" ? x.proxy_from_chat_completions === true : false, enabled: x.enabled !== false })).filter((x) => x.public_model && x.url); } saveConfig(config); res.json(sanitizeConfig()); });
app.post("/api/test", async (req, res) => { const type = req.body?.type, id = req.body?.id; if (!["chat_completions", "responses"].includes(type) || !id) return res.status(400).json({ ok: false, error: "Invalid test request" }); const entry = (config[type] || []).find((x) => x.id === id); if (!entry) return res.status(404).json({ ok: false, error: "Upstream not found" }); try { const result = await performTest(entry, type); res.json({ ok: true, status: result.status, text: extractTestText(result.body, type), raw: result.body }); } catch (e) { res.status(502).json({ ok: false, error: e.message }); } });
app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(LISTEN_PORT, LISTEN_HOST, () => console.log(`LLM Proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`));
