const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { SocksProxyAgent } = require("socks-proxy-agent");

const CONFIG_FILE = process.env.CONFIG_FILE || path.join(__dirname, "config.json");
const SOCKS5_PROXY = process.env.SOCKS5_PROXY || "";
const TIMEOUT = Number(process.env.UPSTREAM_TIMEOUT || 120000);
const PROMPT = "请用中文写一段约两百字的完整回复，主题是“为什么人工智能值得学习”。只输出正文，不要标题、列表、Markdown、前言或结语说明。请尽量接近两百字。";

function config() { try { return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")); } catch { return { chat_completions: [], responses: [] }; } }
function proxyOn(e) { return e.use_proxy !== false && Boolean(SOCKS5_PROXY); }
function target(e, type, forceChat = false) {
  const u = new URL(String(e.url || "").trim());
  if (!u.pathname || u.pathname === "/") u.pathname = forceChat || type === "chat_completions" ? "/v1/chat/completions" : "/v1/responses";
  if (forceChat) u.pathname = u.pathname.replace(/\/responses\/?$/, "/chat/completions");
  return u;
}
function responseToChat(body) {
  const messages = [];
  if (body.instructions) messages.push({ role: "system", content: String(body.instructions) });
  if (typeof body.input === "string") messages.push({ role: "user", content: body.input });
  else if (Array.isArray(body.input)) for (const x of body.input) {
    if (typeof x === "string") messages.push({ role: "user", content: x });
    else if (x.type === "message") messages.push({ role: x.role || "user", content: typeof x.content === "string" ? x.content : (Array.isArray(x.content) ? x.content.map(p => p.text || "").join("") : "") });
    else if (x.type === "input_text") messages.push({ role: "user", content: x.text || "" });
  }
  const out = { model: body.model, messages, stream: true };
  if (body.max_output_tokens != null) out.max_tokens = body.max_output_tokens;
  return out;
}
function streamTest(entry, type) {
  return new Promise(resolve => {
    let u;
    try { u = target(entry, type, type === "responses" && entry.proxy_from_chat_completions === true); } catch (e) { resolve({ ok: false, error: e.message }); return; }
    const model = entry.upstream_model || entry.public_model;
    const body = type === "responses"
      ? (entry.proxy_from_chat_completions === true ? responseToChat({ model, input: PROMPT, max_output_tokens: 500 }) : { model, input: PROMPT, stream: true, max_output_tokens: 500 })
      : { model, messages: [{ role: "user", content: PROMPT }], stream: true, max_tokens: 500 };
    const payload = Buffer.from(JSON.stringify(body));
    const headers = { host: u.host, "content-type": "application/json", "content-length": payload.length, accept: "text/event-stream" };
    if (entry.key) headers.authorization = `Bearer ${entry.key}`;
    const transport = u.protocol === "https:" ? https : http;
    const agent = proxyOn(entry) ? new SocksProxyAgent(SOCKS5_PROXY) : undefined;
    const req = transport.request({ protocol:u.protocol, hostname:u.hostname, port:u.port || (u.protocol === "https:" ? 443 : 80), method:"POST", path:u.pathname+u.search, headers, ...(agent ? {agent} : {}) }, res => {
      const started = process.hrtime.bigint(); let first = null; let text = ""; let buf = ""; let usage = null;
      res.setEncoding("utf8");
      res.on("data", chunk => { buf += chunk; const lines = buf.split(/\r?\n/); buf = lines.pop() || ""; for (const line of lines) { if (!line.startsWith("data:")) continue; const raw=line.slice(5).trim(); if(!raw||raw==="[DONE]") continue; let d; try{d=JSON.parse(raw)}catch{continue} if(d.usage) usage=d.usage; const delta=type === "responses" && !entry.proxy_from_chat_completions ? (d.delta || d.output_text?.delta || "") : (d.choices?.[0]?.delta?.content || ""); if(delta){if(first===null)first=process.hrtime.bigint(); text+=delta;} } });
      res.on("end", () => { const end=process.hrtime.bigint(); const ttft=first===null?null:Number(first-started)/1e6; const gen=first===null?null:Number(end-first)/1e6; const chars=[...text].length; const tokens=usage?.completion_tokens ?? usage?.output_tokens ?? null; resolve({ok:res.statusCode>=200&&res.statusCode<300,status:res.statusCode||0,error:res.statusCode>=400?`HTTP ${res.statusCode}`:null,ttft_ms:ttft===null?null:Math.round(ttft),generation_ms:gen===null?null:Math.round(gen),total_ms:Math.round(Number(end-started)/1e6),generated_chars:chars,completion_tokens:tokens,chars_per_second:gen&&chars?Math.round(chars/(gen/1000)*10)/10:null,tokens_per_second:tokens!=null&&gen>0?Math.round(tokens/(gen/1000)*10)/10:null,text}); });
      res.on("error", e => resolve({ok:false,error:e.message}));
    });
    req.setTimeout(TIMEOUT,()=>req.destroy(new Error("Upstream request timeout")));
    req.on("error",e=>resolve({ok:false,error:e.message})); req.end(payload);
  });
}
function simpleTest(entry,type){
  return new Promise((resolve,reject)=>{ let u; try{u=target(entry,type,type==="responses"&&entry.proxy_from_chat_completions===true)}catch(e){reject(e);return} const model=entry.upstream_model||entry.public_model; const body=type==="responses"?{model,input:"你好"}:{model,messages:[{role:"user",content:"你好"}]}; const payload=Buffer.from(JSON.stringify(body)); const headers={host:u.host,"content-type":"application/json","content-length":payload.length}; if(entry.key)headers.authorization=`Bearer ${entry.key}`; const transport=u.protocol==="https:"?https:http; const agent=proxyOn(entry)?new SocksProxyAgent(SOCKS5_PROXY):undefined; const req=transport.request({protocol:u.protocol,hostname:u.hostname,port:u.port||(u.protocol==="https:"?443:80),method:"POST",path:u.pathname+u.search,headers,...(agent?{agent}: {})},res=>{const chunks=[];res.on("data",c=>chunks.push(c));res.on("end",()=>{const raw=Buffer.concat(chunks).toString("utf8");if(res.statusCode>=400){let m=raw;try{m=JSON.parse(raw)?.error?.message||m}catch{}reject(new Error(`HTTP ${res.statusCode}: ${m}`));return}resolve({status:res.statusCode||200,text:extract(raw,type)})});res.on("error",reject)});req.setTimeout(TIMEOUT,()=>req.destroy(new Error("Upstream request timeout")));req.on("error",reject);req.end(payload)});
}
function extract(raw,type){try{const d=JSON.parse(raw);if(type==="responses")return d.output_text || (d.output||[]).flatMap(x=>x.content||[]).filter(x=>x.text).map(x=>x.text).join("") || JSON.stringify(d,null,2);return typeof d.choices?.[0]?.message?.content==="string"?d.choices[0].message.content:JSON.stringify(d,null,2)}catch{return raw}}

function register(app){
  app.post("/api/test", async (req,res)=>{const {type,id}=req.body||{};if(!["chat_completions","responses"].includes(type)||!id)return res.status(400).json({ok:false,error:"Invalid test request"});const entry=(config()[type]||[]).find(x=>x.id===id);if(!entry)return res.status(404).json({ok:false,error:"Upstream not found"});try{const r=await simpleTest(entry,type);res.json({ok:true,status:r.status,text:r.text})}catch(e){res.status(502).json({ok:false,error:e.message})}});
  app.post("/api/test-all", async (req,res)=>{const c=config(), results=[];for(const type of ["chat_completions","responses"])for(const entry of c[type]||[]){if(entry.enabled===false||!entry.public_model||!entry.url)continue;const r=await streamTest(entry,type);results.push({type,id:entry.id,model:entry.public_model,upstream_model:entry.upstream_model||entry.public_model,...r})}res.json({ok:true,prompt:PROMPT,results})});
}
module.exports={register};
