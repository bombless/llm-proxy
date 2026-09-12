<script setup>
import { reactive } from 'vue'

const props = defineProps({
  state: { type: Object, required: true },
  savedState: { type: Object, required: true },
  types: { type: Array, required: true },
  rowResults: { type: Object, required: true },
})

const emit = defineEmits(['add', 'remove', 'test'])

function snapshot(x) {
  return { id: x.id, public_model: x.public_model, url: x.url, key: x.key, upstream_model: x.upstream_model, use_proxy: x.use_proxy, proxy_from_chat_completions: x.proxy_from_chat_completions, cache_price: x.cache_price, prefill_price: x.prefill_price, generation_price: x.generation_price, enabled: x.enabled }
}
function isSaved(type, x) {
  const old = props.savedState[type].find(y => y.id === x.id)
  return !!old && JSON.stringify(snapshot(old)) === JSON.stringify(snapshot(x))
}
</script>

<template>
  <div>
    <section v-for="section in types" :key="section.key" class="card">
      <div class="section-head"><div><h2>{{ section.title }}</h2><div class="hint">公开模型名 → 上游地址 / Key / 上游模型名 / 代理 / 价格（USD / 1M tokens）</div></div><button class="btn secondary" @click="emit('add', section.key)">＋ 添加</button></div>
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
          <label class="price-input-wrap"><input v-model.number="row.cache_price" type="number" min="0" step="0.000001" placeholder="$/1M" aria-label="缓存价格（USD / 1M tokens）" /><span class="price-badge">缓存</span></label>
          <label class="price-input-wrap"><input v-model.number="row.prefill_price" type="number" min="0" step="0.000001" placeholder="$/1M" aria-label="预填充价格（USD / 1M tokens）" /><span class="price-badge">预填充</span></label>
          <label class="price-input-wrap"><input v-model.number="row.generation_price" type="number" min="0" step="0.000001" placeholder="输出价格（USD / 1M tokens）" /><span class="price-badge">输出</span></label>
          <label v-if="section.key === 'responses'" class="check"><input v-model="row.proxy_from_chat_completions" type="checkbox" /> 从 Chat Completions 代理</label>
          <button v-if="isSaved(section.key, row)" class="btn secondary" @click="emit('test', section.key, row)">{{ rowResults[`${section.key}:${row.id}`]?.loading ? '测试中…' : '测试“你好”' }}</button>

        </div>
        <pre v-if="rowResults[`${section.key}:${row.id}`]" class="result" :class="{ error: rowResults[`${section.key}:${row.id}`].error }">{{ rowResults[`${section.key}:${row.id}`].text }}</pre>
        <hr/>
      </div>
    </section>
  </div>
</template>

<style scoped>
.config-row { display: grid; gap: 8px; align-items: center; margin-top: 10px; }
.config-row input:not([type="checkbox"]) { min-width: 0; padding: 10px 11px; border: 1px solid #d8dadd; border-radius: 8px; outline: none; }
.config-row input:not([type="checkbox"]):focus { border-color: #999; box-shadow: 0 0 0 3px #0000000a; }
.config-row.info { grid-template-columns: 1fr 1.3fr .9fr 1fr .85fr 1fr; }
.config-row.price { grid-template-columns: 2fr 2fr 2fr 1fr; }
.responses .config-row.price { grid-template-columns: 2fr 2fr 2fr 1fr 1fr; }
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
