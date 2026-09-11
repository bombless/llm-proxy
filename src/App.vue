<script setup>
import { onMounted, reactive, ref } from 'vue'
import ModelBenchmark from './components/ModelBenchmark.vue'
import StatsPanel from './components/StatsPanel.vue'

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

    <ModelBenchmark :configs="state" :saved-configs="savedState" :types="types" @notice="showNotice" />
    <StatsPanel :configs="state" :types="types" />

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
