<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  configs: { type: Object, required: true },
  types: { type: Array, required: true },
})

const metrics = ref({ chat_completions: [], responses: [] })
const loading = ref(false)
let timer

const rows = computed(() => props.types.flatMap(type => (props.configs[type.key] || []).map(config => ({
  type: type.key,
  title: type.title,
  config,
  samples: metrics.value[type.key]?.find(x => x.id === config.id)?.samples || [],
})).filter(x => x.config.public_model)))

function formatMs(value) {
  return value == null ? '—' : `${value} ms`
}

function formatSpeed(sample) {
  if (sample.tokens_per_second != null) return `${sample.tokens_per_second} tok/s`
  if (sample.chars_per_second != null) return `${sample.chars_per_second} 字符/s`
  return '—'
}

function formatTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

async function load() {
  loading.value = true
  try {
    const response = await fetch('/api/metrics', { cache: 'no-store' })
    if (response.ok) metrics.value = await response.json()
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  timer = window.setInterval(load, 2000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <section class="card metrics-panel">
    <div class="section-head">
      <div>
        <h2>调用统计</h2>
        <div class="hint">正常通过代理流式调用时自动记录；每个配置保留最近 10 次。TTFT 从代理收到请求开始计算。</div>
      </div>
      <button class="btn secondary refresh-btn" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>

    <div v-if="!rows.length" class="empty">暂无配置。</div>
    <div v-for="row in rows" :key="`${row.type}:${row.config.id}`" class="metric-config">
      <div class="metric-config-head">
        <div>
          <strong>{{ row.config.public_model }}</strong>
          <span class="metric-type">{{ row.title }}</span>
          <span v-if="row.config.upstream_model && row.config.upstream_model !== row.config.public_model" class="hint">→ {{ row.config.upstream_model }}</span>
        </div>
        <span class="metric-count">{{ row.samples.length }}/10 次</span>
      </div>

      <div v-if="!row.samples.length" class="metric-empty">还没有统计数据。需要有一次正常的流式模型调用后才会出现。</div>
      <div v-else class="table-wrap">
        <table class="metric-table">
          <thead><tr><th>#</th><th>时间</th><th>首字时间</th><th>生成速度</th><th>生成量</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="(sample, index) in [...row.samples].reverse()" :key="`${sample.at}-${index}`">
              <td>{{ row.samples.length - index }}</td>
              <td>{{ formatTime(sample.at) }}</td>
              <td class="metric">{{ formatMs(sample.ttft_ms) }}</td>
              <td class="metric">{{ formatSpeed(sample) }}</td>
              <td class="metric">{{ sample.completion_tokens != null ? `${sample.completion_tokens} tok` : `${sample.generated_chars || 0} 字符` }}</td>
              <td>{{ sample.status >= 200 && sample.status < 300 ? '完成' : `HTTP ${sample.status}` }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.metrics-panel { margin-top: 0; }
.metric-config { margin-top: 16px; padding-top: 14px; border-top: 1px solid #e8e9eb; }
.metric-config:first-of-type { border-top: 0; padding-top: 0; }
.metric-config-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.metric-type, .metric-count { margin-left: 8px; color: #777; font-size: 12px; }
.metric-empty { margin-top: 8px; padding: 10px 12px; color: #999; background: #fafbfc; border-radius: 8px; font-size: 13px; }
.metric-table { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 12px; }
.metric-table th, .metric-table td { padding: 7px 8px; border-bottom: 1px solid #eef0f2; text-align: left; vertical-align: middle; }
.metric-table th { color: #777; font-weight: 600; }
</style>
