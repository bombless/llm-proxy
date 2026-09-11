<script setup>
import { computed, onMounted, reactive, ref } from 'vue'

const types = [
  { key: 'chat_completions', title: 'Chat Completions' },
  { key: 'responses', title: 'Responses' },
]

const state = reactive({ chat_completions: [], responses: [] })
const savedState = reactive({ chat_completions: [], responses: [] })
const results = ref([])
const benchmarkRunning = ref(false)
const live = ref(null)
const busy = ref(false)
const notice = ref('')
const rowResults = reactive({})

const prompt = '请用中文写一段约两百字的完整回复，主题是“为什么人工智能值得学习”。只输出正文，不要标题、列表、Markdown、前言或结语说明。请尽量接近两百字。'
const hasConfigs = computed(() => types.some(({ key }) => state[key].some(x => x.enabled !== false && x.public_model && x.url)))

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function snapshot(x) {
  return { id: x.id, public_model: x.public_model, url: x.url, key: x.key, upstream_model: x.upstream_model, use_proxy: x.use_proxy, proxy_from_chat_completions: x.proxy_from_chat_completions, enabled: x.enabled }
}
function isSaved(type, x) {
  const old = savedState[type].find(y => y.id === x.id)
  return !!old && JSON.stringify(snapshot(old)) === JSON.stringify(snapshot(x))
}
function makeRow() {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, public_model: '', url: '', key: '', upstream_model: '', use_proxy: true, proxy_from_chat_completions: false, enabled: true }
}
function addRow(type) { state[type].push(makeRow()) }
function removeRow(type, index) { state[type].splice(index, 1) }
function showNotice(message) { notice.value = message; window.clearTimeout(showNotice.timer); showNotice.timer = window.setTimeout(() => notice.value = '', 2200) }

async function load() {
  try {
    const response = await fetch('/api/config')
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    for (const type of types.map(x => x.key)) {
      state[type].splice(0, state[type].length, ...(data[type] || []))
      savedState[type].splice(0, savedState[type].length, ...clone(data[type] || []))
    }
  } catch (error) {
    showNotice(`加载配置失败：${error.message}`)
  }
}

async function save() {
  busy.value = true
  try {
    const response = await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    for (const type of types.map(x => x.key)) {
      state[type].splice(0, state[type].length, ...(data[type] || []))
      savedState[type].splice(0, savedState[type].length, ...clone(data[type] || []))
    }
    showNotice('已保存')
  } catch (error) {
    showNotice(`保存失败：${error.message}`)
  } finally { busy.value = false }
}

async function testRow(type, row) {
  if (!isSaved(type, row)) return
  const key = `${type}:${row.id}`
  rowResults[key] = { loading: true, text: '' }
  try {
    const response = await fetch('/api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, id: row.id }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || '测试失败')
    rowResults[key] = { loading: false, text: `HTTP ${data.status}\n${data.text || ''}` }
  } catch (error) {
    rowResults[key] = { loading: false, text: error.message, error: true }
  }
}

function formatMs(value) { return value == null ? '—' : `${value} ms` }
function formatSpeed(row) {
  if (row.tokens_per_second != null) return `${row.tokens_per_second} tok/s`
  if (row.chars_per_second != null) return `${row.chars_per_second} 字符/s`
  return '—'
}

function updateLive(patch) { live.value = { ...(live.value || {}), ...patch } }

async function streamBenchmark(type, model) {
  const startedAt = performance.now()
  let firstTextAt = null
  let text = ''
  let buffer = ''
  let usage = null
  const body = type === 'responses'
    ? { model, input: prompt, stream: true, max_output_tokens: 500 }
    : { model, messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 500 }

  updateLive({ type, model, status: `等待 ${model} 返回首字`, text: '' })
  const response = await fetch(type === 'responses' ? '/v1/responses' : '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body),
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try { message = (await response.json()).error?.message || message } catch {}
    throw new Error(message)
  }
  if (!response.body) throw new Error('浏览器不支持流式响应')
  updateLive({ status: `已连接，等待 ${model} 返回首字` })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const consume = chunk => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      let data
      try { data = JSON.parse(raw) } catch { continue }
      if (data.usage) usage = data.usage
      let delta = ''
      if (type === 'responses') {
        if (typeof data.delta === 'string' && String(data.type || '').includes('output_text')) delta = data.delta
        else if (typeof data.output_text?.delta === 'string') delta = data.output_text.delta
      } else if (typeof data.choices?.[0]?.delta?.content === 'string') delta = data.choices[0].delta.content
      if (!delta) continue
      if (firstTextAt === null) {
        firstTextAt = performance.now()
        updateLive({ status: '已返回首字，正在流式生成', ttft_ms: Math.round(firstTextAt - startedAt) })
      }
      text += delta
      updateLive({ status: '流式返回中', text: text.slice(-160) })
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    consume(decoder.decode(value, { stream: true }))
  }
  consume(decoder.decode())
  const finishedAt = performance.now()
  const generationMs = firstTextAt == null ? null : finishedAt - firstTextAt
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? null
  const chars = [...text].length
  return {
    ok: true, status: response.status, type, model, text,
    ttft_ms: firstTextAt == null ? null : Math.round(firstTextAt - startedAt),
    total_ms: Math.round(finishedAt - startedAt),
    generated_chars: chars,
    completion_tokens: completionTokens,
    chars_per_second: generationMs && chars ? Math.round(chars / (generationMs / 1000) * 10) / 10 : null,
    tokens_per_second: completionTokens != null && generationMs > 0 ? Math.round(completionTokens / (generationMs / 1000) * 10) / 10 : null,
  }
}

async function testAll() {
  if (benchmarkRunning.value) return
  benchmarkRunning.value = true
  results.value = []
  live.value = null
  const entries = []
  for (const type of types.map(x => x.key)) {
    for (const row of state[type]) {
      if (row.enabled === false || !row.public_model || !row.url || !isSaved(type, row)) continue
      entries.push({ type, model: row.public_model, upstream_model: row.upstream_model || row.public_model })
    }
  }
  try {
    for (const item of entries) {
      const running = { ...item, running: true }
      results.value.push(running)
      try {
        const result = await streamBenchmark(item.type, item.model)
        const index = results.value.indexOf(running)
        if (index >= 0) results.value.splice(index, 1, { ...result, upstream_model: item.upstream_model })
      } catch (error) {
        const index = results.value.indexOf(running)
        if (index >= 0) results.value.splice(index, 1, { ...item, ok: false, error: error.message, running: false })
      }
    }
    showNotice('所有配置测试完成')
  } finally {
    live.value = null
    benchmarkRunning.value = false
  }
}

onMounted(load)
</script>

<template>
  <main class="wrap">
    <header class="hero">
      <div>
        <div class="eyebrow">OPENAI-COMPATIBLE GATEWAY</div>
        <h1>LLM Proxy</h1>
        <p>把多个 OpenAI-compatible 接口汇集到统一的 <code>/v1</code> 地址。Responses 可直接代理，也可转换成 Chat Completions。</p>
      </div>
      <button class="btn primary" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存配置' }}</button>
    </header>

    <section class="card benchmark">
      <div class="section-head">
        <div><h2>模型性能测试</h2><div class="hint">逐个测试所有已启用配置，测量首字延迟（TTFT）和生成速度。</div></div>
        <button class="btn" :disabled="benchmarkRunning || !hasConfigs" @click="testAll">{{ benchmarkRunning ? '测试中…' : '测试所有配置' }}</button>
      </div>
      <div v-if="live" class="bench-live"><strong>正在测试 {{ live.model }}</strong><div>{{ live.status }}</div><small v-if="live.text">{{ live.text }}</small></div>
      <div v-if="!results.length" class="empty">{{ benchmarkRunning ? '准备测试…' : '点击按钮开始测试。' }}</div>
      <div v-else class="table-wrap">
        <table class="bench-table">
          <thead><tr><th>类型</th><th>模型</th><th>状态</th><th>首字延迟</th><th>生成速度</th><th>生成量</th><th>总耗时</th><th>回复</th></tr></thead>
          <tbody>
            <tr v-for="(result, index) in results" :key="`${result.type}:${result.model}:${index}`">
              <td>{{ result.type === 'responses' ? 'Responses' : 'Chat Completions' }}</td>
              <td><strong>{{ result.model }}</strong><div v-if="result.upstream_model && result.upstream_model !== result.model" class="hint">→ {{ result.upstream_model }}</div></td>
              <td :class="result.running ? 'bench-running' : result.ok ? 'bench-ok' : 'bench-error'">{{ result.running ? '测试中…' : result.ok ? '完成' : '失败' }}<span v-if="result.status"> · HTTP {{ result.status }}</span><div v-if="result.error">{{ result.error }}</div></td>
              <td class="metric">{{ formatMs(result.ttft_ms) }}</td><td class="metric">{{ formatSpeed(result) }}<span v-if="result.completion_tokens != null" class="hint"> ({{ result.completion_tokens }} tok)</span></td>
              <td class="metric">{{ result.generated_chars != null ? `${result.generated_chars} 字符` : '—' }}</td><td class="metric">{{ formatMs(result.total_ms) }}</td><td><div class="bench-text">{{ result.text || '' }}</div></td>
            </tr>
          </tbody>
        </table>
        <div class="bench-summary">已完成 {{ results.filter(x => !x.running).length }} 个配置<span v-if="results.some(x => !x.running && !x.ok)">，失败 {{ results.filter(x => !x.running && !x.ok).length }} 个</span>。TTFT 从请求发出开始计算。</div>
      </div>
    </section>

    <section v-for="section in types" :key="section.key" class="card">
      <div class="section-head"><div><h2>{{ section.title }}</h2><div class="hint">公开模型名 → 上游地址 / Key / 上游模型名 / 代理</div></div><button class="btn secondary" @click="addRow(section.key)">＋ 添加</button></div>
      <div v-if="!state[section.key].length" class="empty">还没有配置。</div>
      <div v-for="(row, index) in state[section.key]" :key="row.id" class="config-row">
        <input v-model="row.public_model" placeholder="公开模型名，如 gpt-4" />
        <input v-model="row.url" placeholder="接口地址，如 https://.../v1/chat/completions" />
        <input v-model="row.key" type="password" placeholder="API Key" />
        <input v-model="row.upstream_model" placeholder="上游模型名" />
        <label class="check"><input v-model="row.use_proxy" type="checkbox" /> SOCKS5</label>
        <label v-if="section.key === 'responses'" class="check"><input v-model="row.proxy_from_chat_completions" type="checkbox" /> 从 Chat Completions 代理</label>
        <button v-if="isSaved(section.key, row)" class="btn secondary" @click="testRow(section.key, row)">{{ rowResults[`${section.key}:${row.id}`]?.loading ? '测试中…' : '测试“你好”' }}</button>
        <button class="btn danger" @click="removeRow(section.key, index)">删除</button>
        <pre v-if="rowResults[`${section.key}:${row.id}`]" class="result" :class="{ error: rowResults[`${section.key}:${row.id}`].error }">{{ rowResults[`${section.key}:${row.id}`].text }}</pre>
      </div>
    </section>
  </main>
  <div v-if="notice" class="status">{{ notice }}</div>
</template>
