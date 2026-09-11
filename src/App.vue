<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import ModelBenchmark from './components/ModelBenchmark.vue'
import MetricsPanel from './components/MetricsPanel.vue'
import UsagePanel from './components/UsagePanel.vue'

const types = [
  { key: 'chat_completions', title: 'Chat Completions' },
  { key: 'responses', title: 'Responses' },
]

const state = reactive({ chat_completions: [], responses: [] })
const savedState = reactive({ chat_completions: [], responses: [] })
const rowResults = reactive({})
const busy = ref(false)
const notice = ref('')

function clone(value) { return JSON.parse(JSON.stringify(value)) }
function snapshot(x) {
  return { id: x.id, public_model: x.public_model, url: x.url, key: x.key, upstream_model: x.upstream_model, use_proxy: x.use_proxy, proxy_from_chat_completions: x.proxy_from_chat_completions, cache_price: x.cache_price, prefill_price: x.prefill_price, generation_price: x.generation_price, enabled: x.enabled }
}
function isSaved(type, x) {
  const old = savedState[type].find(y => y.id === x.id)
  return !!old && JSON.stringify(snapshot(old)) === JSON.stringify(snapshot(x))
}
const hasUnsavedChanges = computed(() => types.some(({ key }) => {
  return JSON.stringify(state[key].map(snapshot)) !== JSON.stringify(savedState[key].map(snapshot))
}))
function makeRow() {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, public_model: '', url: '', key: '', upstream_model: '', use_proxy: true, proxy_from_chat_completions: false, cache_price: 0, prefill_price: 0, generation_price: 0, enabled: true }
}
function addRow(type) { state[type].push(makeRow()) }
function removeRow(type, index) { state[type].splice(index, 1) }
function showNotice(message) { notice.value = message; window.clearTimeout(showNotice.timer); showNotice.timer = window.setTimeout(() => notice.value = '', 2200) }

function handleBeforeUnload(event) {
  if (!hasUnsavedChanges.value) return
  event.preventDefault()
  event.returnValue = ''
}

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

onMounted(() => {
  window.addEventListener('beforeunload', handleBeforeUnload)
  load()
})

onUnmounted(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
})
</script>

<template>
  <main class="wrap">
    <header class="hero">
      <div>
        <div class="eyebrow">OPENAI-COMPATIBLE GATEWAY</div>
        <h1>LLM Proxy</h1>
        <p>把多个 OpenAI-compatible 接口汇集到统一的 <code>/v1</code> 地址。Responses 可直接代理，也可转换成 Chat Completions。</p>
      </div>
    </header>

    <UsagePanel :configs="state" :types="types" />
    <MetricsPanel :configs="state" :types="types" />

    <ModelBenchmark :configs="state" :saved-configs="savedState" :types="types" @notice="showNotice" />

    <section v-for="section in types" :key="section.key" class="card">
      <div class="section-head"><div><h2>{{ section.title }}</h2><div class="hint">公开模型名 → 上游地址 / Key / 上游模型名 / 代理 / 价格（USD / 1M tokens）</div></div><button class="btn secondary" @click="addRow(section.key)">＋ 添加</button></div>
      <div v-if="!state[section.key].length" class="empty">还没有配置。</div>
      <div v-for="(row, index) in state[section.key]" :key="row.id">
        <div class="config-row info">
          <input :id="`model-${section.key}-${index}`" v-model="row.public_model" placeholder="公开模型名，如 gpt-4" />
          <input :id="`url-${section.key}-${index}`" v-model="row.url" placeholder="接口地址，如 https://.../v1/chat/completions" />
          <input :id="`key-${section.key}-${index}`" v-model="row.key" type="password" placeholder="API Key" />
          <input :id="`upstream-model-${section.key}-${index}`" v-model="row.upstream_model" placeholder="上游模型名" />
          <label class="check"><input v-model="row.use_proxy" type="checkbox" /> SOCKS5</label>
        </div>
        <div class="config-row price">
          <label class="price-input-wrap">
            <input :id="`cache-price-${section.key}-${index}`" v-model.number="row.cache_price" type="number" min="0" step="0.000001" placeholder="$/1M" aria-label="缓存价格（USD / 1M tokens）" />
            <span class="price-badge">缓存</span>
          </label>
          <label class="price-input-wrap">
            <input :id="`prefill-price-${section.key}-${index}`" v-model.number="row.prefill_price" type="number" min="0" step="0.000001" placeholder="$/1M" aria-label="预填充价格（USD / 1M tokens）" />
            <span class="price-badge">预填充</span>
          </label>
          <label class="price-input-wrap">
            <input :id="`output-price-${section.key}-${index}`" v-model.number="row.generation_price" type="number" min="0" step="0.000001" placeholder="输出价格（USD / 1M tokens）" />
            <span class="price-badge">输出</span>
          </label>
          <label v-if="section.key === 'responses'" class="check"><input v-model="row.proxy_from_chat_completions" type="checkbox" /> 从 Chat Completions 代理</label>
          <button v-if="isSaved(section.key, row)" class="btn secondary" @click="testRow(section.key, row)">{{ rowResults[`${section.key}:${row.id}`]?.loading ? '测试中…' : '测试“你好”' }}</button>
          <button class="btn danger" @click="removeRow(section.key, index)">删除</button>
        </div>
        <pre v-if="rowResults[`${section.key}:${row.id}`]" class="result" :class="{ error: rowResults[`${section.key}:${row.id}`].error }">{{ rowResults[`${section.key}:${row.id}`].text }}</pre>
        <hr/>
      </div>
    </section>
  </main>
  <button class="btn primary save-fab" :disabled="busy" @click="save">{{ busy ? '保存中…' : '保存配置' }}</button>
  <div v-if="notice" class="status">{{ notice }}</div>
</template>

<style>
* { box-sizing: border-box; }
:root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #17181a; background: #f6f7f9; font-synthesis: none; }
body { margin: 0; min-width: 320px; background: #f6f7f9; }
button, input { font: inherit; }
button { border: 0; }
.wrap { max-width: 1250px; margin: 0 auto; padding: 40px 18px 64px; }
.hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 20px; }
.eyebrow { color: #777; font-size: 11px; font-weight: 700; letter-spacing: .12em; }
h1 { margin: 4px 0 6px; font-size: 32px; line-height: 1.1; }
h2 { margin: 0; font-size: 19px; }
p { margin: 0; max-width: 850px; color: #666; line-height: 1.7; }
code { padding: 2px 5px; border-radius: 5px; background: #eceef0; }
.card { margin: 18px 0; padding: 20px; background: #fff; border: 1px solid #e3e5e8; border-radius: 14px; box-shadow: 0 2px 8px #00000008; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.hint { margin-top: 5px; color: #777; font-size: 13px; }
.btn { padding: 9px 13px; border-radius: 8px; background: #17181a; color: #fff; cursor: pointer; white-space: nowrap; }
.btn.primary { background: #1677ff; }
.btn.secondary { background: #eceef0; color: #222; }
.btn.danger { background: #d83b3b; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.refresh-btn { min-width: 6em; display: inline-block; }
.save-fab { position: fixed; right: 20px; bottom: 20px; z-index: 20; padding: 12px 18px; border-radius: 10px; box-shadow: 0 6px 18px #0003; }
.config-row { display: grid; gap: 8px; align-items: center; margin-top: 10px; }
.config-row input:not([type="checkbox"]) { min-width: 0; padding: 10px 11px; border: 1px solid #d8dadd; border-radius: 8px; outline: none; }
.config-row input:not([type="checkbox"]):focus { border-color: #999; box-shadow: 0 0 0 3px #0000000a; }
.check { display: flex; align-items: center; gap: 5px; color: #444; font-size: 13px; white-space: nowrap; }
.check input { width: 17px; height: 17px; }
.empty { padding: 16px 0 4px; color: #999; }
.status { position: fixed; left: 18px; top: 18px; right: auto; bottom: auto; z-index: 30; max-width: min(600px, calc(100vw - 36px)); padding: 10px 14px; border-radius: 9px; background: #17181a; color: #fff; box-shadow: 0 8px 24px #0003; }
.result { grid-column: 1 / -1; width: 100%; margin: 0; padding: 10px; border-radius: 9px; background: #f6f7f9; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.result.error, .bench-error { color: #b42318; }
.table-wrap { overflow-x: auto; }
.metric { font-variant-numeric: tabular-nums; white-space: nowrap; }
.config-row.info { grid-template-columns: 1fr 1.3fr .9fr 1fr .85fr; }
.config-row.price { grid-template-columns: 2fr 2fr 2fr 1fr 1fr; }
.price-input-wrap { position: relative; display: block; min-width: 0; }
.price-input-wrap input { width: 100%; padding-right: 58px !important; -moz-appearance: textfield; appearance: textfield; }
.price-input-wrap input::-webkit-outer-spin-button,
.price-input-wrap input::-webkit-inner-spin-button { margin: 0; -webkit-appearance: none; }
.price-badge { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); padding: 2px 6px; border: 1px solid #e4b72f; border-radius: 999px; background: #fff3a6; color: #6b5100; font-size: 11px; line-height: 1.3; font-weight: 700; pointer-events: none; white-space: nowrap; }
@media (max-width: 1100px) { .config-row { grid-template-columns: 1fr 1fr; } }
@media (max-width: 700px) { .hero, .section-head { align-items: flex-start; flex-direction: column; } .config-row { grid-template-columns: 1fr; } .wrap { padding-top: 24px; padding-bottom: 88px; } .save-fab { right: 16px; bottom: 16px; } }
</style>
