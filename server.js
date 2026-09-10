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

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.raw({ type: "application/octet-stream", limit: "50mb" }));

const DEFAULT_CONFIG = { chat_completions: [], responses: [] };

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }
}

function saveConfig(config) {
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

let config = loadConfig();
if (!fs.existsSync(CONFIG_FILE)) saveConfig(config);

function upstreamFor(type, publicModel) {
  return (config[type] || []).find((x) => x.public_model === publicModel && x.enabled !== false);
}

function sanitizeConfig() {
  return {
    chat_completions: (config.chat_completions || []).map((x) => ({ ...x, key: x.key ? "********" : "" })),
    responses: (config.responses || []).map((x) => ({ ...x, key: x.key ? "********" : "" })),
  };
}

function getBodyBuffer(req) {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body));
  return Buffer.alloc(0);
}

function makeTargetUrl(entry, type) {
  const raw = String(entry.url || "").trim();
  if (!raw) throw new Error("Upstream URL is empty");
  const target = new URL(raw);
  if (!target.pathname || target.pathname === "/") {
    target.pathname = type === "responses" ? "/v1/responses" : "/v1/chat/completions";
  }
  return target;
}

function hopByHop(name) {
  return ["connection", "proxy-connection", "keep-alive", "transfer-encoding", "host", "content-length"].includes(name.toLowerCase());
}

function proxyRequest(req, res, type) {
  const original = req.body && !Buffer.isBuffer(req.body) ? req.body : null;
  let publicModel;
  if (original && typeof original === "object") publicModel = original.model;
  else {
    try { publicModel = JSON.parse(getBodyBuffer(req).toString("utf8")).model; } catch {}
  }

  const entry = upstreamFor(type, publicModel);
  if (!entry) {
    return res.status(404).json({ error: { message: `No upstream configured for model: ${publicModel || "(missing)"}`, type: "model_not_configured" } });
  }

  let target;
  try { target = makeTargetUrl(entry, type); } catch (e) {
    return res.status(500).json({ error: { message: e.message, type: "proxy_config_error" } });
  }

  let body = getBodyBuffer(req);
  if (original && typeof original === "object") {
    const rewritten = { ...original, model: entry.upstream_model || publicModel };
    body = Buffer.from(JSON.stringify(rewritten));
  } else if (body.length) {
    try {
      const parsed = JSON.parse(body.toString("utf8"));
      parsed.model = entry.upstream_model || publicModel;
      body = Buffer.from(JSON.stringify(parsed));
    } catch {}
  }

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (!hopByHop(key)) headers[key] = value;
  }
  headers.host = target.host;
  headers["content-length"] = body.length;
  if (entry.key) headers.authorization = `Bearer ${entry.key}`;

  const transport = target.protocol === "https:" ? https : http;
  const agent = SOCKS5_PROXY ? new SocksProxyAgent(SOCKS5_PROXY) : undefined;
  const options = {
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || (target.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: target.pathname + target.search,
    headers,
    ...(agent ? { agent } : {}),
  };

  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} model=${publicModel} -> ${target.href} upstreamModel=${entry.upstream_model || publicModel}`);

  const proxyReq = transport.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode || 502);
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!hopByHop(key) && value !== undefined) res.setHeader(key, value);
    }
    proxyRes.pipe(res);
    proxyRes.on("error", (err) => {
      console.error("Upstream response error:", err);
      if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: "proxy_error" } });
      else res.destroy(err);
    });
  });

  proxyReq.setTimeout(Number(process.env.UPSTREAM_TIMEOUT || 120000), () => proxyReq.destroy(new Error("Upstream request timeout")));
  proxyReq.on("error", (err) => {
    console.error("Proxy request error:", err.message);
    if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: "proxy_error" } });
    else res.destroy(err);
  });
  if (body.length) proxyReq.write(body);
  proxyReq.end();
}

// Public OpenAI-compatible endpoints.
app.all("/v1/chat/completions", (req, res) => proxyRequest(req, res, "chat_completions"));
app.all("/v1/responses", (req, res) => proxyRequest(req, res, "responses"));

app.get("/v1/models", (req, res) => {
  const models = [
    ...(config.chat_completions || []).filter((x) => x.enabled !== false).map((x) => ({ id: x.public_model, object: "model", owned_by: "llm-proxy", endpoint: "chat_completions" })),
    ...(config.responses || []).filter((x) => x.enabled !== false).map((x) => ({ id: x.public_model, object: "model", owned_by: "llm-proxy", endpoint: "responses" })),
  ];
  res.json({ object: "list", data: models });
});

// Configuration UI/API. Keep this service on a trusted/private network.
app.get("/api/config", (req, res) => res.json(sanitizeConfig()));
app.put("/api/config", (req, res) => {
  const incoming = req.body || {};
  for (const type of ["chat_completions", "responses"]) {
    if (!Array.isArray(incoming[type])) continue;
    config[type] = incoming[type].map((x) => ({
      id: String(x.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
      public_model: String(x.public_model || "").trim(),
      url: String(x.url || "").trim(),
      key: x.key === "********" ? ((config[type] || []).find((old) => old.id === x.id)?.key || "") : String(x.key || ""),
      upstream_model: String(x.upstream_model || "").trim(),
      enabled: x.enabled !== false,
    })).filter((x) => x.public_model && x.url);
  }
  saveConfig(config);
  res.json(sanitizeConfig());
});

app.get("/health", (req, res) => res.json({ ok: true }));

const INDEX_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Proxy</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#17181a;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1100px;margin:36px auto;padding:0 18px}h1{margin:0 0 6px;font-size:28px}p{color:#666}.card{background:#fff;border:1px solid #e3e5e8;border-radius:14px;padding:20px;margin:18px 0;box-shadow:0 2px 8px #00000008}.head{display:flex;justify-content:space-between;align-items:center;gap:10px}.head h2{margin:0;font-size:19px}.row{display:grid;grid-template-columns:1.05fr 1.35fr 1fr 1.05fr auto;gap:8px;margin:10px 0;align-items:center}.row input{min-width:0;padding:10px 11px;border:1px solid #d8dadd;border-radius:8px;font-size:14px}.btn{border:0;border-radius:8px;padding:9px 13px;cursor:pointer;background:#17181a;color:white}.btn.secondary{background:#eceef0;color:#222}.btn.danger{background:#d83b3b}.actions{display:flex;gap:8px;margin-top:14px}label{font-size:12px;color:#777}.toggle{width:38px;height:20px}.status{position:fixed;right:18px;bottom:18px;background:#17181a;color:#fff;padding:10px 14px;border-radius:9px;display:none}.hint{font-size:13px;color:#777}.empty{color:#999;padding:10px 0}@media(max-width:800px){.row{grid-template-columns:1fr 1fr}.row .delete{grid-column:auto}.head{align-items:flex-start;flex-direction:column}}
</style></head><body><div class="wrap"><h1>LLM Proxy</h1><p>把多个 OpenAI-compatible 接口汇集到统一的 <code>/v1</code> 地址。客户端只需要使用这里设置的公开模型名。</p><div id="app"></div></div><div id="status" class="status"></div>
<script>
let state={chat_completions:[],responses:[]};
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function section(type,title){const a=state[type]||[];return '<div class="card"><div class="head"><h2>'+title+'</h2><button class="btn secondary" onclick="addRow(\''+type+'\')">+ 添加</button></div><div class="hint">公开模型名 → 上游地址 / Key / 上游模型名</div><div id="rows-'+type+'">'+(a.length?a.map((x,i)=>row(type,x,i)).join(''):'<div class="empty">还没有配置。</div>')+'</div></div>'}
function row(type,x,i){return '<div class="row"><input placeholder="公开模型名，如 gpt-4" value="'+esc(x.public_model)+'" oninput="edit(\''+type+'\','+i+',\'public_model\',this.value)"><input placeholder="接口地址，如 https://.../v1/chat/completions" value="'+esc(x.url)+'" oninput="edit(\''+type+'\','+i+',\'url\',this.value)"><input type="password" placeholder="API Key" value="'+esc(x.key)+'" oninput="edit(\''+type+'\','+i+',\'key\',this.value)"><input placeholder="上游模型名" value="'+esc(x.upstream_model)+'" oninput="edit(\''+type+'\','+i+',\'upstream_model\',this.value)"><button class="btn danger delete" onclick="delRow(\''+type+'','+i+')">删除</button></div>'}
function edit(t,i,k,v){state[t][i][k]=v} function addRow(t){state[t].push({id:String(Date.now()+Math.random()),public_model:'',url:'',key:'',upstream_model:'',enabled:true});render()} function delRow(t,i){state[t].splice(i,1);render()}
async function load(){state=await (await fetch('/api/config')).json();render()} async function save(){const r=await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});state=await r.json();render();flash('已保存')} function render(){document.getElementById('app').innerHTML=section('chat_completions','Chat Completions')+section('responses','Responses')+'<div class="card"><div class="hint">客户端地址：当前服务的 <code>/v1/chat/completions</code>、<code>/v1/responses</code>、<code>/v1/models</code></div><div class="actions"><button class="btn" onclick="save()">保存全部配置</button></div></div>'} function flash(s){const e=document.getElementById('status');e.textContent=s;e.style.display='block';setTimeout(()=>e.style.display='none',1500)} load();
</script></body></html>`;

app.get("/", (req, res) => res.type("html").send(INDEX_HTML));

app.use((req, res) => res.status(404).json({ error: { message: "Not found", type: "proxy_error" } }));

const server = app.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`LLM proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
  console.log(`Config: ${CONFIG_FILE}`);
  console.log(`SOCKS5: ${SOCKS5_PROXY ? "enabled" : "disabled"}`);
});

function shutdown() { server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
