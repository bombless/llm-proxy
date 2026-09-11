<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({ configs: { type: Object, required: true }, types: { type: Array, required: true } })
const summary = ref({ total: 0, errors: 0, rate: 0 })
const stats = ref([])
const linePoints = ref([])
const loading = ref(false)
const range = ref('24h')
let timer

const ranges = [
  { key: '4h', label: '最近 4 小时' },
  { key: '12h', label: '最近 12 小时' },
  { key: '24h', label: '最近 24 小时' },
  { key: 'today', label: '今天' },
  { key: '72h', label: '最近 72 小时' },
  { key: '7d', label: '最近一周' },
]

const totalCalls = computed(() => Number(summary.value.total || 0))
const totalErrors = computed(() => Number(summary.value.errors || 0))
const totalRate = computed(() => Number(summary.value.rate || 0))
const maxErrors = computed(() => Math.max(1, ...stats.value.map(x => Number(x.errors || 0))))
const pieGradient = computed(() => {
  const total = totalErrors.value
  if (!total) return 'conic-gradient(#e8eaed 0 100%)'
  let cursor = 0
  const parts = stats.value.filter(x => x.errors).map((x, i) => {
    const start = cursor; cursor += x.errors / total * 100
    const end = cursor; const hue = (i * 53 + 8) % 360
    return `hsl(${hue} 68% 52%) ${start}% ${end}%`
  })
  return `conic-gradient(${parts.join(',')})`
})
const linePath = computed(() => linePoints.value.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' '))
function formatRate(n) { return `${Number(n || 0).toFixed(n >= 10 ? 0 : 1)}%` }
function formatHour(at) { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
function normalizeTimeline(points) {
  return points.map((p, i) => ({ ...p, x: 8 + i * (84 / Math.max(1, points.length - 1)), y: 92 - Number(p.rate || 0) * .84 }))
}
async function load() {
  loading.value = true
  try {
    const query = `?range=${encodeURIComponent(range.value)}`
    const [summaryResponse, modelsResponse, timelineResponse] = await Promise.all([
      fetch(`/api/error-stats/summary${query}`, { cache: 'no-store' }),
      fetch(`/api/error-stats/models${query}`, { cache: 'no-store' }),
      fetch('/api/error-stats/timeline?hours=24', { cache: 'no-store' }),
    ])
    if (summaryResponse.ok) summary.value = await summaryResponse.json()
    if (modelsResponse.ok) stats.value = (await modelsResponse.json()).models || []
    if (timelineResponse.ok) linePoints.value = normalizeTimeline((await timelineResponse.json()).points || [])
  } catch (_) {
    // Keep the last successful values visible when a refresh fails.
  } finally { loading.value = false }
}
onMounted(() => { load(); timer = window.setInterval(load, 10000) })
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <section class="card errors-panel">
    <div class="section-head">
      <div><h2>错误统计</h2><div class="hint">错误统计由后端独立接口直接聚合完整调用历史，不受 /api/usage 最近 200 条记录的限制。</div></div>
      <button class="btn secondary refresh-btn" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>

    <div class="range-tabs">
      <button v-for="item in ranges" :key="item.key" :class="{ active: range === item.key }" @click="range = item.key; load()">{{ item.label }}</button>
    </div>

    <div class="error-summary">
      <div><span>调用次数</span><strong>{{ totalCalls }}</strong></div>
      <div><span>错误次数</span><strong>{{ totalErrors }}</strong></div>
      <div><span>错误率</span><strong>{{ formatRate(totalRate) }}</strong></div>
    </div>

    <div class="charts">
      <article class="chart-card">
        <div class="chart-title">错误占比 · 按模型</div>
        <div v-if="totalErrors" class="pie-row"><div class="pie" :style="{ background: pieGradient }"></div><div class="legend"><div v-for="(item, i) in stats.filter(x => x.errors)" :key="item.model"><i :style="{ background: `hsl(${(i * 53 + 8) % 360} 68% 52%)` }"></i><span>{{ item.model }}</span><b>{{ item.errors }}</b></div></div></div>
        <div v-else class="chart-empty">当前时间范围没有错误记录。</div>
      </article>

      <article class="chart-card line-card">
        <div class="chart-title">过去 24 小时 · 每小时错误率</div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" class="line-chart" role="img" aria-label="过去24小时每小时错误率折线图">
          <line v-for="y in [8, 29, 50, 71, 92]" :key="y" x1="8" :y1="y" x2="92" :y2="y" class="grid" />
          <path :d="linePath" class="line" />
          <circle v-for="point in linePoints" :key="point.at" :cx="point.x" :cy="point.y" r="1.25" class="dot"><title>{{ formatHour(point.at) }} · {{ formatRate(point.rate) }} · {{ point.errors }}/{{ point.total }}</title></circle>
        </svg>
        <div class="axis"><span>{{ formatHour(linePoints[0]?.at || Date.now()) }}</span><span>错误率</span><span>{{ formatHour(linePoints.at(-1)?.at || Date.now()) }}</span></div>
      </article>
    </div>

    <article class="chart-card bars-card">
      <div class="chart-title">错误记录 · 各模型</div>
      <div v-if="stats.length" class="bars">
        <div v-for="item in stats" :key="item.model" class="bar-row"><div class="bar-label" :title="item.model">{{ item.model }}</div><div class="bar-track"><div class="bar-fill" :style="{ width: `${item.errors / maxErrors * 100}%` }"></div></div><div class="bar-value">{{ item.errors }} 次 · {{ formatRate(item.rate) }}</div></div>
      </div>
      <div v-else class="chart-empty">当前时间范围没有调用记录。</div>
    </article>

    <div class="table-wrap" v-if="stats.length">
      <table class="error-table"><thead><tr><th>模型</th><th>调用次数</th><th>错误次数</th><th>错误率</th></tr></thead><tbody><tr v-for="item in stats" :key="item.model"><td><strong>{{ item.model }}</strong></td><td>{{ item.total }}</td><td>{{ item.errors }}</td><td class="metric">{{ formatRate(item.rate) }}</td></tr></tbody></table>
    </div>
  </section>
</template>

<style scoped>
.errors-panel { margin-top: 0; }
.range-tabs { display:flex; flex-wrap:wrap; gap:6px; margin-top:16px; }
.range-tabs button { padding:7px 10px; border:1px solid #e1e3e6; border-radius:8px; background:#fff; color:#666; cursor:pointer; font-size:12px; }
.range-tabs button.active { background:#17181a; color:#fff; border-color:#17181a; }
.error-summary { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin-top:14px; }
.error-summary div { padding:14px 16px; border:1px solid #e7e8ea; border-radius:10px; background:#fafbfc; }
.error-summary span { display:block; color:#777; font-size:12px; }.error-summary strong { display:block; margin-top:5px; font-size:24px; font-variant-numeric:tabular-nums; }
.charts { display:grid; grid-template-columns:minmax(280px,.8fr) minmax(420px,1.2fr); gap:14px; margin-top:14px; }
.chart-card { padding:16px; border:1px solid #e7e8ea; border-radius:12px; background:#fff; }.chart-title { font-size:13px; font-weight:700; margin-bottom:12px; }.pie-row { display:flex; align-items:center; gap:22px; min-height:210px; }.pie { width:180px; height:180px; flex:0 0 auto; border-radius:50%; }.legend { flex:1; min-width:0; }.legend div { display:grid; grid-template-columns:10px minmax(0,1fr) auto; align-items:center; gap:7px; margin:7px 0; font-size:12px; }.legend i { width:8px; height:8px; border-radius:50%; }.legend span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.line-chart { display:block; width:100%; height:210px; overflow:visible; }.grid { stroke:#eceef0; stroke-width:.35; }.line { fill:none; stroke:#17181a; stroke-width:1.5; vector-effect:non-scaling-stroke; }.dot { fill:#1677ff; vector-effect:non-scaling-stroke; }.axis { display:flex; justify-content:space-between; color:#999; font-size:10px; }.axis span:nth-child(2) { color:#777; }.bars-card { margin-top:14px; }.bars { display:flex; flex-direction:column; gap:10px; }.bar-row { display:grid; grid-template-columns:minmax(100px,180px) minmax(100px,1fr) 120px; align-items:center; gap:10px; font-size:12px; }.bar-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.bar-track { height:18px; background:#f0f1f3; border-radius:5px; overflow:hidden; }.bar-fill { height:100%; min-width:2px; background:#e05252; border-radius:5px; }.bar-value { text-align:right; color:#666; font-variant-numeric:tabular-nums; }.chart-empty { display:flex; align-items:center; justify-content:center; min-height:180px; color:#999; font-size:13px; }.error-table { width:100%; margin-top:14px; border-collapse:collapse; font-size:12px; }.error-table th,.error-table td { padding:8px; border-bottom:1px solid #eef0f2; text-align:left; }.error-table th { color:#777; }
@media(max-width:800px){.charts{grid-template-columns:1fr}.pie-row{justify-content:center}.bar-row{grid-template-columns:minmax(90px,1fr) minmax(80px,2fr);}.bar-value{text-align:left;grid-column:2}.error-summary{grid-template-columns:1fr 1fr 1fr}.pie{width:150px;height:150px}}
</style>
