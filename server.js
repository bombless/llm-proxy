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
function loadConfig() { try { return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; } catch { return JSON.parse(JSON.stringify(DEFAULT_CONFIG)); } }
function saveConfig(config) { const tmp = `${CONFIG_FILE}.tmp`; fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 }); fs.renameSync(tmp, CONFIG_FILE); }
let config = loadConfig();
if (!fs.existsSync(CONFIG_FILE)) saveConfig(config);
function upstreamFor(type, publicModel) { return (config[type] || []).find((x) => x.public_model === publicModel && x.enabled !== false); }
function sanitizeConfig() { return { chat_completions: (config.chat_completions || []).map((x) => ({ ...x, key: x.key ? "********" : "" })), responses: (config.responses || []).map((x) => ({ ...x, key: x.key ? "********" : "" })) }; }
function getBodyBuffer(req) { if (Buffer.isBuffer(req.body)) return req.body; if (req.body && typeof req.body === "object") return Buffer.from(JSON.stringify(req.body)); return Buffer.alloc(0); }
function makeTargetUrl(entry, type) { const raw = String(entry.url || "").trim(); if (!raw) throw new Error("Upstream URL is empty"); const target = new URL(raw); if (!target.pathname || target.pathname === "/") target.pathname = type === "responses" ? "/v1/responses" : "/v1/chat/completions"; return target; }
function hopByHop(name) { return ["connection", "proxy-connection", "keep-alive", "transfer-encoding", "host", "content-length"].includes(name.toLowerCase()); }
function entryUsesProxy(entry) { return entry.use_proxy !== false && Boolean(SOCKS5_PROXY); }

function proxyRequest(req, res, type) {
  const original = req.body && !Buffer.isBuffer(req.body) ? req.body : null;
  let publicModel;
  if (original && typeof original === "object") publicModel = original.model;
  else { try { publicModel = JSON.parse(getBodyBuffer(req).toString("utf8")).model; } catch {} }
  const entry = upstreamFor(type, publicModel);
  if (!entry) return res.status(404).json({ error: { message: `No upstream configured for model: ${publicModel || "(missing)"}`, type: "model_not_configured" } });
  let target;
  try { target = makeTargetUrl(entry, type); } catch (e) { return res.status(500).json({ error: { message: e.message, type: "proxy_config_error" } }); }
  let body = getBodyBuffer(req);
  if (original && typeof original === "object") body = Buffer.from(JSON.stringify({ ...original, model: entry.upstream_model || publicModel }));
  else if (body.length) { try { const parsed = JSON.parse(body.toString("utf8")); parsed.model = entry.upstream_model || publicModel; body = Buffer.from(JSON.stringify(parsed)); } catch {} }
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) if (!hopByHop(key)) headers[key] = value;
  headers.host = target.host; headers["content-length"] = body.length;
  if (entry.key) headers.authorization = `Bearer ${entry.key}`;
  const transport = target.protocol === "https:" ? https : http;
  const agent = entryUsesProxy(entry) ? new SocksProxyAgent(SOCKS5_PROXY) : undefined;
  const options = { protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), method: req.method, path: target.pathname + target.search, headers, ...(agent ? { agent } : {}) };
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl} model=${publicModel} -> ${target.href} upstreamModel=${entry.upstream_model || publicModel} proxy=${entryUsesProxy(entry) ? "on" : "off"}`);
  const proxyReq = transport.request(options, (proxyRes) => { res.status(proxyRes.statusCode || 502); for (const [key, value] of Object.entries(proxyRes.headers)) if (!hopByHop(key) && value !== undefined) res.setHeader(key, value); proxyRes.pipe(res); proxyRes.on("error", (err) => { console.error("Upstream response error:", err); if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: "proxy_error" } }); else res.destroy(err); }); });
  proxyReq.setTimeout(Number(process.env.UPSTREAM_TIMEOUT || 120000), () => proxyReq.destroy(new Error("Upstream request timeout")));
  proxyReq.on("error", (err) => { console.error("Proxy request error:", err.message); if (!res.headersSent) res.status(502).json({ error: { message: err.message, type: "proxy_error" } }); else res.destroy(err); });
  if (body.length) proxyReq.write(body); proxyReq.end();
}

function performTest(entry, type) {
  return new Promise((resolve, reject) => {
    let target; try { target = makeTargetUrl(entry, type); } catch (e) { reject(e); return; }
    const model = entry.upstream_model || entry.public_model;
    const body = type === "responses" ? { model, input: "你好" } : { model, messages: [{ role: "user", content: "你好" }] };
    const payload = Buffer.from(JSON.stringify(body));
    const headers = { host: target.host, "content-type": "application/json", "content-length": payload.length };
    if (entry.key) headers.authorization = `Bearer ${entry.key}`;
    const transport = target.protocol === "https:" ? https : http;
    const agent = entryUsesProxy(entry) ? new SocksProxyAgent(SOCKS5_PROXY) : undefined;
    const options = { protocol: target.protocol, hostname: target.hostname, port: target.port || (target.protocol === "https:" ? 443 : 80), method: "POST", path: target.pathname + target.search, headers, ...(agent ? { agent } : {}) };
    const request = transport.request(options, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => { const raw = Buffer.concat(chunks).toString("utf8"); if ((response.statusCode || 500) >= 400) { let message = raw; try { message = JSON.parse(raw)?.error?.message || message; } catch {} reject(new Error(`HTTP ${response.statusCode}: ${message}`)); return; } resolve({ status: response.statusCode || 200, body: raw }); }); response.on("error", reject);
    });
    request.setTimeout(Number(process.env.UPSTREAM_TIMEOUT || 120000), () => request.destroy(new Error("Upstream request timeout")));
    request.on("error", reject); request.end(payload);
  });
}
function extractTestText(raw, type) {
  try { const data = JSON.parse(raw); if (type === "responses") { if (typeof data.output_text === "string") return data.output_text; const parts = []; for (const item of data.output || []) for (const content of item.content || []) if (typeof content.text === "string") parts.push(content.text); if (parts.length) return parts.join(""); } else { const content = data.choices?.[0]?.message?.content; if (typeof content === "string") return content; if (Array.isArray(content)) return content.map((x) => x.text || "").join(""); } return JSON.stringify(data, null, 2); } catch { return raw; }
}

app.all("/v1/chat/completions", (req, res) => proxyRequest(req, res, "chat_completions"));
app.all("/v1/responses", (req, res) => proxyRequest(req, res, "responses"));
app.get("/v1/models", (req, res) => { const models = [...(config.chat_completions || []).filter((x) => x.enabled !== false).map((x) => ({ id: x.public_model, object: "model", owned_by: "llm-proxy", endpoint: "chat_completions" })), ...(config.responses || []).filter((x) => x.enabled !== false).map((x) => ({ id: x.public_model, object: "model", owned_by: "llm-proxy", endpoint: "responses" }))]; res.json({ object: "list", data: models }); });
app.get("/api/config", (req, res) => res.json(sanitizeConfig()));
app.put("/api/config", (req, res) => { const incoming = req.body || {}; for (const type of ["chat_completions", "responses"]) { if (!Array.isArray(incoming[type])) continue; config[type] = incoming[type].map((x) => ({ id: String(x.id || `${Date.now()}-${Math.random().toString(36).slice(2)}`), public_model: String(x.public_model || "").trim(), url: String(x.url || "").trim(), key: x.key === "********" ? ((config[type] || []).find((old) => old.id === x.id)?.key || "") : String(x.key || ""), upstream_model: String(x.upstream_model || "").trim(), use_proxy: x.use_proxy !== false, enabled: x.enabled !== false })).filter((x) => x.public_model && x.url); } saveConfig(config); res.json(sanitizeConfig()); });
app.post("/api/test", async (req, res) => { const type = req.body?.type, id = req.body?.id; if (!["chat_completions", "responses"].includes(type) || !id) return res.status(400).json({ ok: false, error: "Invalid test request" }); const entry = (config[type] || []).find((x) => x.id === id); if (!entry) return res.status(404).json({ ok: false, error: "Upstream not found" }); try { const result = await performTest(entry, type); res.json({ ok: true, status: result.status, text: extractTestText(result.body, type), raw: result.body }); } catch (e) { res.status(502).json({ ok: false, error: e.message }); } });
app.get("/health", (req, res) => res.json({ ok: true }));

const INDEX_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LLM Proxy</title><style>*{box-sizing:border-box}body{margin:0;background:#f6f7f9;color:#17181a;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.wrap{max-width:1200px;margin:36px auto;padding:0 18px}h1{margin:0 0 6px;font-size:28px}p{color:#666}.card{background:#fff;border:1px solid #e3e5e8;border-radius:14px;padding:20px;margin:18px 0;box-shadow:0 2px 8px #00000008}.head{display:flex;justify-content:space-between;align-items:center;gap:10px}.head h2{margin:0;font-size:19px}.row{display:grid;grid-template-columns:1fr 1.25fr .9fr 1fr auto auto auto;gap:8px;margin:10px 0;align-items:center}.row input{min-width:0;padding:10px 11px;border:1px solid #d8dadd;border-radius:8px;font-size:14px}.btn{border:0;border-radius:8px;padding:9px 13px;cursor:pointer;background:#17181a;color:white;white-space:nowrap}.btn.secondary{background:#eceef0;color:#222}.btn.danger{background:#d83b3b}.actions{display:flex;gap:8px;margin-top:14px}.proxy{display:flex;align-items:center;gap:5px;white-space:nowrap;font-size:13px}.proxy input{width:18px;height:18px}.status{position:fixed;right:18px;bottom:18px;background:#17181a;color:#fff;padding:10px 14px;border-radius:9px;display:none;max-width:min(600px,calc(100vw - 36px));white-space:pre-wrap}.hint{font-size:13px;color:#777}.empty{color:#999;padding:10px 0}.result{grid-column:1/-1;background:#f6f7f9;border-radius:9px;padding:10px;white-space:pre-wrap;word-break:break-word;font-size:13px;display:block}.result.error{background:#fff0f0}@media(max-width:1000px){.row{grid-template-columns:1fr 1fr}.row .result{grid-column:1/-1}}@media(max-width:600px){.row{grid-template-columns:1fr}}</style></head><body><div class="wrap"><h1>LLM Proxy</h1><p>把多个 OpenAI-compatible 接口汇集到统一的 <code>/v1</code> 地址。每个接口可以单独选择是否通过 SOCKS5 代理，并可直接发送“你好”测试。</p><div id="app"></div></div><div id="status" class="status"></div><script>
let state={chat_completions:[],responses:[]};
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
function section(type,title){const a=state[type]||[];return '<div class="card"><div class="head"><h2>'+title+'</h2><button class="btn secondary" onclick="addRow(\\''+type+'\\')">+ 添加</button></div><div class="hint">公开模型名 → 上游地址 / Key / 上游模型名 / 代理</div><div id="rows-'+type+'">'+(a.length?a.map((x,i)=>row(type,x,i)).join(''):'<div class="empty">还没有配置。</div>')+'</div></div>'}
function row(type,x,i){const rid='result-'+type+'-'+i;return '<div class="row"><input placeholder="公开模型名，如 gpt-4" value="'+esc(x.public_model)+'" oninput="edit(\\''+type+'\\','+i+',\\'public_model\\',this.value)"><input placeholder="接口地址，如 https://.../v1/chat/completions" value="'+esc(x.url)+'" oninput="edit(\\''+type+'\\','+i+',\\'url\\',this.value)"><input type="password" placeholder="API Key" value="'+esc(x.key)+'" oninput="edit(\\''+type+'\\','+i+',\\'key\\',this.value)"><input placeholder="上游模型名" value="'+esc(x.upstream_model)+'" oninput="edit(\\''+type+'\\','+i+',\\'upstream_model\\',this.value)"><label class="proxy"><input type="checkbox" '+(x.use_proxy!==false?'checked':'')+' onchange="edit(\\''+type+'\\','+i+',\\'use_proxy\\',this.checked)">代理</label><button class="btn secondary" onclick="testRow(\\''+type+'\\','+i+')">测试“你好”</button><button class="btn danger delete" onclick="delRow(\\''+type+'\\','+i+')">删除</button><div id="'+rid+'" class="result" style="display:none"></div></div>'}
function edit(t,i,k,v){state[t][i][k]=v} function addRow(t){state[t].push({id:String(Date.now()+Math.random()),public_model:'',url:'',key:'',upstream_model:'',use_proxy:true,enabled:true});render()} function delRow(t,i){state[t].splice(i,1);render()}
async function load(){state=await (await fetch('/api/config')).json();render()} async function save(){const r=await fetch('/api/config',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(state)});if(!r.ok){flash('保存失败');return}state=await r.json();render();flash('已保存')}
async function testRow(t,i){const x=state[t][i];const el=document.getElementById('result-'+t+'-'+i);el.style.display='block';el.className='result';el.textContent='测试中……';try{const r=await fetch('/api/test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:t,id:x.id})});const data=await r.json();if(data.ok){el.textContent='HTTP '+data.status+'\\n\\n'+data.text}else{el.className='result error';el.textContent='测试失败：'+(data.error||'未知错误')}}catch(e){el.className='result error';el.textContent='测试失败：'+e.message}}
function render(){document.getElementById('app').innerHTML=section('chat_completions','Chat Completions')+section('responses','Responses')+'<div class="card"><div class="hint">客户端地址：当前服务的 <code>/v1/chat/completions</code>、<code>/v1/responses</code>、<code>/v1/models</code></div><div class="actions"><button class="btn" onclick="save()">保存全部配置</button></div></div>'} function flash(s){const e=document.getElementById('status');e.textContent=s;e.style.display='block';setTimeout(()=>e.style.display='none',1500)} load();
</script></body></html>`;
app.get("/", (req, res) => res.type("html").send(INDEX_HTML));
app.use((req, res) => res.status(404).json({ error: { message: "Not found", type: "proxy_error" } }));
const server = app.listen(LISTEN_PORT, LISTEN_HOST, () => { console.log(`LLM proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`); console.log(`Config: ${CONFIG_FILE}`); console.log(`SOCKS5: ${SOCKS5_PROXY ? "available" : "disabled"}`); });
function shutdown() { server.close(() => process.exit(0)); }
process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
