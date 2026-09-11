<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  configs: { type: Object, required: true },
  types: { type: Array, required: true },
})

const stats = ref({ chat_completions: {}, responses: {} })
const loading = ref(false)
let timer

async function loadStats() {
  try {
    const response = await fetch('/api/stats', { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    stats.value = await response.json()
  } catch {
    // The proxy may be restarting; keep the last successful snapshot visible.
  }
}

function rows(type) {
  return (props.configs[type] || []).map(config => ({
    config,
    samples: stats.value[type]?.[config.id] || [],
  }))
}

const sections = computed(() => props.types.map(type => ({
  ...type,
  rows: rows(type.key),
})))

function ms(value) {
  return value == null ? '—' : `${Math.round(value)} ms`
}
function speed(sample) {
  if (sample.tokens_per_second != null) return `${sample.tokens_per_second.toFixed(1)} tok/s`
  if (sample.chars_per_second != null) return `${sample.chars_per_second.toFixed(1)} char/s`
  return '—'
}
function formatTime(value) {
  if (!value) return ''
  return new Date(value).toLocaleTimeString()
}

onMounted(() => {
  loadStats()
  timer = window.setInterval(loadStats, 3000)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <section class="card stats-panel">
    <div class="section-head">
      <div>
        <h2>调用统计</h2>
        <div class="hint">记录实际流式调用的最近 10 次首字时间（TTFT）和生成速度；优先显示 token/s，没有 token 用量时显示 char/s。</div>
      </div>
      <span class="stats-live">{{ loading ? '刷新中…' : '每 3 秒刷新' }}</span>
    </div>

    <div v-for="section in sections" :key="section.key" class="stats-section">
      <h3>{{ section.title }}</h3>
      <div v-if="!section.rows.length" class="empty">还没有配置。</div>
      <div v-for="row in section.rows" :key="row.config.id" class="stats-config">
        <div class="stats-config-head">
          <strong>{{ row.config.public_model }}</strong>
          <span>{{ row.samples.length }}/10 次</span>
        </div>
        <div v-if="!row.samples.length" class="stats-empty">暂无实际调用数据</div>
        <div v-else class="table-wrap">
          <table class="stats-table">
            <thead>
              <tr><th>时间</th><th>首字时间</th><th>生成速度</th><th>生成时长</th><th>Tokens</th></tr>
            </thead>
            <tbody>
              <tr v-for="sample in row.samples.slice().reverse()" :key="sample.at">
                <td>{{ formatTime(sample.at) }}</td>
                <td class="metric">{{ ms(sample.ttft_ms) }}</td>
                <td class="metric">{{ speed(sample) }}</td>
                <td class="metric">{{ ms(sample.generation_ms) }}</td>
                <td class="metric">{{ sample.completion_tokens ?? '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.card { margin: 18px 0; padding: 20px; background: #fff; border: 1px solid #e3e5e8; border-radius: 14px; box-shadow: 0 2px 8px #00000008; }
.section-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
.section-head h2 { margin: 0; font-size: 19px; }
.hint { margin-top: 5px; color: #777; font-size: 13px; }
.empty { padding: 16px 0 4px; color: #999; }
.table-wrap { overflow-x: auto; }
.metric { font-variant-numeric: tabular-nums; white-space: nowrap; }
.stats-panel { margin-top: 18px; }
.stats-live { color: #777; font-size: 12px; white-space: nowrap; }
.stats-section + .stats-section { margin-top: 24px; }
.stats-section h3 { margin: 18px 0 10px; font-size: 15px; }
.stats-config { padding: 12px 0; border-top: 1px solid #e8e9eb; }
.stats-config-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.stats-config-head span { color: #777; font-size: 12px; }
.stats-empty { padding: 10px 0 2px; color: #999; font-size: 13px; }
.stats-table { width: 100%; margin-top: 8px; border-collapse: collapse; font-size: 12px; }
.stats-table th, .stats-table td { padding: 8px; border-bottom: 1px solid #eef0f2; text-align: left; vertical-align: middle; }
.stats-table th { color: #777; font-weight: 600; }
</style>
