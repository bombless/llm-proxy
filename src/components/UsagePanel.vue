<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({ configs: { type: Object, required: true }, types: { type: Array, required: true } })
const usage = ref({ summary: [], recent: [] })
const loading = ref(false)
let timer

const rows = computed(() => props.types.flatMap(type => (props.configs[type.key] || []).map(config => {
  const item = usage.value.summary.find(x => x.type === type.key && x.config_id === config.id)
  return { type, config, item }
}).filter(x => x.config.public_model)))
const total = computed(() => rows.value.reduce((sum, row) => sum + Number(row.item?.total_cost || 0), 0))
function money(value) { return `$${Number(value || 0).toFixed(6)}` }
function tokens(value) { return value == null ? '—' : Number(value).toLocaleString() }
function prefillTokens(item) { return Math.max(0, Number(item?.input_tokens || 0) - Number(item?.cached_tokens || 0)) }
function billableTokens(item) { return Number(item?.cached_tokens || 0) + prefillTokens(item) + Number(item?.output_tokens || 0) }
function load() {
  loading.value = true
  fetch('/api/usage', { cache: 'no-store' }).then(r => r.ok ? r.json() : Promise.reject()).then(data => { usage.value = data }).catch(() => {}).finally(() => { loading.value = false })
}
onMounted(() => { load(); timer = window.setInterval(load, 3000) })
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <section class="card usage-panel">
    <div class="section-head">
      <div><h2>费用统计</h2><div class="hint">按每个配置独立统计调用次数、缓存 / 预填充 / 生成 token 和费用；价格单位为 USD / 1M tokens。</div></div>
      <div class="usage-total">累计 {{ money(total) }} <span class="usage-total-tokens">({{ tokens(rows.reduce((sum, row) => sum + billableTokens(row.item), 0)) }} tokens)</span> <button class="btn secondary" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button></div>
    </div>
    <div v-if="!rows.length" class="empty">暂无配置。</div>
    <div v-for="row in rows" :key="`${row.type.key}:${row.config.id}`" class="usage-config">
      <div class="usage-config-head"><div><strong>{{ row.config.public_model }}</strong><span class="metric-type">{{ row.type.title }}</span></div><strong>{{ money(row.item?.total_cost) }} <span class="usage-cost-tokens">({{ tokens(billableTokens(row.item)) }} tokens)</span></strong></div>
      <div class="usage-grid">
        <div><span>调用</span><strong>{{ row.item?.calls || 0 }}</strong></div>
        <div><span>输入</span><strong>{{ tokens(row.item?.input_tokens) }}</strong></div>
        <div><span>缓存</span><strong>{{ tokens(row.item?.cached_tokens) }}</strong></div>
        <div><span>输出</span><strong>{{ tokens(row.item?.output_tokens) }}</strong></div>
        <div><span>缓存费用</span><strong>{{ money(row.item?.cache_cost) }} <small>({{ tokens(row.item?.cached_tokens) }} tokens)</small></strong></div>
        <div><span>预填充费用</span><strong>{{ money(row.item?.prefill_cost) }} <small>({{ tokens(prefillTokens(row.item)) }} tokens)</small></strong></div>
        <div><span>生成费用</span><strong>{{ money(row.item?.generation_cost) }} <small>({{ tokens(row.item?.output_tokens) }} tokens)</small></strong></div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.usage-total { display: flex; align-items: center; gap: 10px; font-weight: 700; }
.usage-total-tokens, .usage-cost-tokens { font-size: 0.85em; font-weight: normal; opacity: 0.75; }
.usage-config { margin-top: 16px; padding-top: 14px; border-top: 1px solid #e8e9eb; }
.usage-config:first-of-type { border-top: 0; padding-top: 0; }
.usage-config-head { display: flex; justify-content: space-between; gap: 12px; }
.metric-type { margin-left: 8px; color: #777; font-size: 12px; }
.usage-grid { display: grid; grid-template-columns: repeat(7, minmax(90px, 1fr)); gap: 8px; margin-top: 10px; }
.usage-grid div { padding: 10px; border-radius: 8px; background: #fafbfc; }
.usage-grid span { display: block; color: #777; font-size: 11px; }
.usage-grid strong { display: block; margin-top: 4px; font-size: 13px; font-variant-numeric: tabular-nums; }
.usage-grid small { font-size: 0.8em; font-weight: normal; opacity: 0.75; }
@media (max-width: 900px) { .usage-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 600px) { .usage-grid { grid-template-columns: repeat(2, 1fr); } }
</style>
