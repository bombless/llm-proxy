<script setup>
import { reactive, ref } from 'vue'

const props = defineProps({
  state: { type: Object, required: true },
  savedState: { type: Object, required: true },
  types: { type: Array, required: true },
  rowResults: { type: Object, required: true },
})

const emit = defineEmits(['add', 'remove', 'test'])

const batchOpen = ref(false)
const batchLoading = ref(false)
const batchError = ref('')
const batchUrl = ref('')
const batchKey = ref('')
const batchUseProxy = ref(false)
const batchType = ref('chat_completions')
const batchModels = ref([])
const selectedModels = ref([])
function openBatch(type) {
  batchType.value = type; batchUrl.value = ''; batchKey.value = ''; batchUseProxy.value = false; batchModels.value = []; selectedModels.value = []; batchError.value = ''; batchOpen.value = true
}
async function discoverModels() {
  batchLoading.value = true; batchError.value = ''
  try {
    const response = await fetch('/api/discover-models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: batchUrl.value, key: batchKey.value, use_proxy: batchUseProxy.value }) })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
    batchModels.value = data.models || []; selectedModels.value = batchModels.value.map(x => x.id)
    if (!batchModels.value.length) batchError.value = '接口返回成功，但没有找到模型。'
  } catch (error) { batchError.value = `获取模型失败：${error.message}` }
  finally { batchLoading.value = false }
}
function addSelectedModels() {
  if (!selectedModels.value.length) return
  const base = new URL(batchUrl.value.trim())
  base.pathname = base.pathname.replace(/\/+$/, '').replace(/\/(chat\/completions|responses|models)$/i, '')
  if (!base.pathname || base.pathname === '/') base.pathname = '/v1'
  const endpoint = `${base.origin}${base.pathname}/${batchType.value === 'responses' ? 'responses' : 'chat/completions'}${base.search}`
  const target = props.state[batchType.value], existing = new Set(target.map(x => `${x.url}::${x.upstream_model}`))
  for (const id of selectedModels.value) {
    const signature = `${endpoint}::${id}`
    if (existing.has(signature)) continue
    target.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, public_model: id, url: endpoint, key: batchKey.value, upstream_model: id, use_proxy: batchUseProxy.value, proxy_from_chat_completions: false, cache_price: 0, prefill_price: 0, generation_price: 0, enabled: true, hidden: false })
    existing.add(signature)
  }
  batchOpen.value = false
}

function snapshot(x) {
  return { id: x.id, public_model: x.public_model, url: x.url, key: x.key, upstream_model: x.upstream_model, use_proxy: x.use_proxy, proxy_from_chat_completions: x.proxy_from_chat_completions, cache_price: x.cache_price, prefill_price: x.prefill_price, generation_price: x.generation_price, enabled: x.enabled, hidden: x.hidden }
}
function isSaved(type, x) {
  const old = props.savedState[type].find(y => y.id === x.id)
  return !!old && JSON.stringify(snapshot(old)) === JSON.stringify(snapshot(x))
}
function clearZeroOnFocus(row, field) {
  if (Number(row[field]) === 0) row[field] = ''
}
</script>

<template>
  <div>
    <section v-for="section in types" :key="section.key" class="card">
      <div class="section-head"><div><h2>{{ section.title }}</h2><div class="hint">公开模型名 → 上游地址 / Key / 上游模型名 / 代理 / 价格（USD / 1M tokens）；隐藏后不参与公开路由和 /v1/models</div></div><div class="actions"><button class="btn secondary" @click="openBatch(section.key)">批量添加</button><button class="btn secondary" @click="emit('add', section.key)">＋ 添加</button></div></div>
      <div v-if="!state[section.key].length" class="empty">还没有配置。</div>
      <div v-for="(row, index) in state[section.key]" :key="row.id" :class="section.key">
        <div class="config-row info">
          <input v-model="row.public_model" placeholder="公开模型名，如 gpt-4" />
          <input v-model="row.url" placeholder="接口地址，如 https://.../v1/chat/completions" />
          <input v-model="row.key" type="password" placeholder="API Key" />
          <input v-model="row.upstream_model" placeholder="上游模型名" />
          <label class="check"><input v-model="row.use_proxy" type="checkbox" /> SOCKS5</label>
          <button class="btn danger" @click="emit('remove', section.key, index)">删除</button>
        </div>
        <div class="config-row price">
          <label class="price-input-wrap"><input v-model.number="row.cache_price" @focus="clearZeroOnFocus(row, 'cache_price')" type="number" min="0" step="0.000001" placeholder="$/1M" aria-label="缓存价格（USD / 1M tokens）" /><span class="price-badge">缓存</span></label>
          <label class="price-input-wrap"><input v-model.number="row.prefill_price" @focus="clearZeroOnFocus(row, 'prefill_price')" type="number" min="0" step="0.000001" placeholder="$/1M" aria-label="预填充价格（USD / 1M tokens）" /><span class="price-badge">预填充</span></label>
          <label class="price-input-wrap"><input v-model.number="row.generation_price" @focus="clearZeroOnFocus(row, 'generation_price')" type="number" min="0" step="0.000001" placeholder="输出价格（USD / 1M tokens）" /><span class="price-badge">输出</span></label>
          <label v-if="section.key === 'responses'" class="check"><input v-model="row.proxy_from_chat_completions" type="checkbox" /> 从 Chat Completions 代理</label>
          <label class="check"><input v-model="row.hidden" type="checkbox" /> 隐藏</label>
          <button v-if="isSaved(section.key, row)" class="btn secondary" @click="emit('test', section.key, row)">{{ rowResults[`${section.key}:${row.id}`]?.loading ? '测试中…' : '测试“你好”' }}</button>

        </div>
        <pre v-if="rowResults[`${section.key}:${row.id}`]" class="result" :class="{ error: rowResults[`${section.key}:${row.id}`].error }">{{ rowResults[`${section.key}:${row.id}`].text }}</pre>
        <hr/>
      </div>
    </section>
    <div v-if="batchOpen" class="modal-backdrop" @click.self="batchOpen = false">
      <section class="batch-modal card" role="dialog" aria-modal="true" aria-labelledby="batch-title">
        <div class="section-head"><h2 id="batch-title">批量添加模型</h2><button class="btn secondary" @click="batchOpen = false">关闭</button></div>
        <label class="field">V1 地址<input v-model="batchUrl" placeholder="https://api.example.com/v1" /></label>
        <label class="field">API Key<input v-model="batchKey" type="password" placeholder="sk-..." /></label>
        <label class="check batch-proxy-check"><input v-model="batchUseProxy" type="checkbox" /> 通过 SOCKS5 代理请求（获取模型和后续模型调用均生效）</label>
        <button class="btn primary" :disabled="batchLoading || !batchUrl.trim()" @click="discoverModels">{{ batchLoading ? '正在获取模型…' : '获取模型列表' }}</button>
        <p v-if="batchError" class="batch-error">{{ batchError }}</p>
        <template v-if="batchModels.length">
          <div class="batch-type"><strong>添加到接口</strong><label><input v-model="batchType" type="radio" value="chat_completions" /> Chat Completions</label><label><input v-model="batchType" type="radio" value="responses" /> Responses</label></div>
          <div class="model-toolbar"><strong>选择模型（{{ selectedModels.length }}/{{ batchModels.length }}）</strong><button class="btn secondary" @click="selectedModels = selectedModels.length === batchModels.length ? [] : batchModels.map(x => x.id)">{{ selectedModels.length === batchModels.length ? '取消全选' : '全选' }}</button></div>
          <div class="model-list"><label v-for="model in batchModels" :key="model.id" class="model-option"><input v-model="selectedModels" type="checkbox" :value="model.id" /><span>{{ model.id }}</span></label></div>
          <button class="btn primary add-selected" :disabled="!selectedModels.length" @click="addSelectedModels">添加所选模型（{{ selectedModels.length }}）</button>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.actions { display: flex; gap: 8px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 18px; background: #0008; }
.batch-modal { width: min(560px, 100%); max-height: min(85vh, 760px); overflow: auto; margin: 0; }
.field { display: grid; gap: 6px; margin-top: 14px; color: #444; font-size: 13px; }
.field input { width: 100%; padding: 10px 11px; border: 1px solid #d8dadd; border-radius: 8px; }
.batch-proxy-check { margin-top: 12px; white-space: normal; }
.batch-error { margin-top: 10px; color: #b42318; font-size: 13px; }
.batch-type,.model-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 14px; margin-top: 18px; }
.batch-type label { display: flex; align-items: center; gap: 5px; font-size: 13px; }
.model-toolbar { justify-content: space-between; }
.model-list { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; max-height: 260px; overflow: auto; margin-top: 10px; padding: 10px; border: 1px solid #e3e5e8; border-radius: 8px; }
.model-option { display: flex; min-width: 0; align-items: center; gap: 8px; font-size: 13px; overflow-wrap: anywhere; }
.add-selected { width: 100%; margin-top: 14px; }
.config-row { display: grid; gap: 8px; align-items: center; margin-top: 10px; }
.config-row input:not([type="checkbox"]) { min-width: 0; padding: 10px 11px; border: 1px solid #d8dadd; border-radius: 8px; outline: none; }
.config-row input:not([type="checkbox"]):focus { border-color: #999; box-shadow: 0 0 0 3px #0000000a; }
.config-row.info { grid-template-columns: 1fr 1.3fr .9fr 1fr .85fr 1fr; }
.config-row.price { grid-template-columns: 2fr 2fr 2fr auto auto; }
.responses .config-row.price { grid-template-columns: 2fr 2fr 2fr auto auto auto; }
.check { display: flex; align-items: center; gap: 5px; color: #444; font-size: 13px; white-space: nowrap; }
.check input { width: 17px; height: 17px; }
.price-input-wrap { position: relative; display: block; min-width: 0; }
.price-input-wrap input { width: 100%; padding-right: 58px !important; -moz-appearance: textfield; appearance: textfield; }
.price-input-wrap input::-webkit-outer-spin-button,.price-input-wrap input::-webkit-inner-spin-button { margin: 0; -webkit-appearance: none; }
.price-badge { position: absolute; top: 50%; right: 8px; transform: translateY(-50%); padding: 2px 6px; border: 1px solid #e4b72f; border-radius: 999px; background: #fff3a6; color: #6b5100; font-size: 11px; line-height: 1.3; font-weight: 700; pointer-events: none; white-space: nowrap; }
.result { grid-column: 1 / -1; width: 100%; margin: 0; padding: 10px; border-radius: 9px; background: #f6f7f9; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
.result.error { color: #b42318; }
@media (max-width: 1100px) { .config-row { grid-template-columns: 1fr 1fr; } }
@media (max-width: 700px) { .config-row { grid-template-columns: 1fr; } }
</style>
