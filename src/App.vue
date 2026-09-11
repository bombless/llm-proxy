<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import ModelBenchmark from './components/ModelBenchmark.vue'
import MetricsPanel from './components/MetricsPanel.vue'
import ProxyConfigPanel from './components/ProxyConfigPanel.vue'
import UsagePanel from './components/UsagePanel.vue'

const types = [
  { key: 'chat_completions', title: 'Chat Completions' },
  { key: 'responses', title: 'Responses' },
]
const tabs = [
  { key: 'proxy', title: '接口配置' },
  { key: 'usage', title: '费用统计' },
  { key: 'metrics', title: '调用统计' },
  { key: 'benchmark', title: '性能测试' },
]

const activeTab = ref('proxy')
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
const hasUnsavedChanges = computed(() => types.some(({ key }) => JSON.stringify(state[key].map(snapshot)) !== JSON.stringify(savedState[key].map(snapshot))))
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
  } catch (error) { showNotice(`加载配置失败：${error.message}`) }
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
  } catch (error) { showNotice(`保存失败：${error.message}`) } finally { busy.value = false }
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
  } catch (error) { rowResults[key] = { loading: false, text: error.message, error: true } }
}
onMounted(() => { window.addEventListener('beforeunload', handleBeforeUnload); load() })
onUnmounted(() => window.removeEventListener('beforeunload', handleBeforeUnload))
</script>

<template>
  <main class="wrap">
    <header class="hero">
      <nav class="tabs" aria-label="Dashboard sections">
        <button v-for="tab in tabs" :key="tab.key" class="tab" :class="{ active: activeTab === tab.key }" @click="activeTab = tab.key">{{ tab.title }}</button>
      </nav>
    </header>

    <ProxyConfigPanel v-show="activeTab === 'proxy'" :state="state" :saved-state="savedState" :types="types" :row-results="rowResults" @add="addRow" @remove="removeRow" @test="testRow" />
    <UsagePanel v-show="activeTab === 'usage'" :configs="state" :types="types" />
    <MetricsPanel v-show="activeTab === 'metrics'" :configs="state" :types="types" />
    <ModelBenchmark v-show="activeTab === 'benchmark'" :configs="state" :saved-configs="savedState" :types="types" @notice="showNotice" />
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
.tabs { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 6px; padding: 5px; border: 1px solid #e0e2e5; border-radius: 10px; background: #fff; }
.tab { padding: 8px 11px; border-radius: 7px; background: transparent; color: #666; cursor: pointer; font-size: 13px; white-space: nowrap; }
.tab:hover { background: #f3f4f6; color: #222; }
.tab.active { background: #17181a; color: #fff; }
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
.empty { padding: 16px 0 4px; color: #999; }
.status { position: fixed; left: 18px; top: 18px; right: auto; bottom: auto; z-index: 30; max-width: min(600px, calc(100vw - 36px)); padding: 10px 14px; border-radius: 9px; background: #17181a; color: #fff; box-shadow: 0 8px 24px #0003; }
.table-wrap { overflow-x: auto; }
.metric { font-variant-numeric: tabular-nums; white-space: nowrap; }
@media (max-width: 900px) { .hero { align-items: flex-start; flex-direction: column; } .tabs { width: 100%; justify-content: flex-start; overflow-x: auto; } }
@media (max-width: 700px) { .wrap { padding-top: 24px; padding-bottom: 88px; } .save-fab { right: 16px; bottom: 16px; } }
</style>
