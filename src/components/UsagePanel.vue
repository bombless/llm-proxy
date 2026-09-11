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
.usage-total-tokens, .usage-cost-tokens { font-size: 0.85em; font-weight: normal; opacity: 0.75; }
.usage-grid small { font-size: 0.8em; font-weight: normal; opacity: 0.75; }
</style>
