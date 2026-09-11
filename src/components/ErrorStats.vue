<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({ configs: { type: Object, required: true }, types: { type: Array, required: true } })
const usage = ref({ recent: [] })
const loading = ref(false)
const range = ref('24h')
let timer

const ranges = [
  { key: '4h', label: '最近 4 小时', ms: 4 * 3600e3 },
  { key: '12h', label: '最近 12 小时', ms: 12 * 3600e3 },
  { key: '24h', label: '最近 24 小时', ms: 24 * 3600e3 },
  { key: 'today', label: '今天', ms: null },
  { key: '72h', label: '最近 72 小时', ms: 72 * 3600e3 },
  { key: '7d', label: '最近一周', ms: 7 * 24 * 3600e3 },
]

const rows = computed(() => Array.isArray(usage.value.recent) ? usage.value.recent : [])
function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() }
function cutoff() { const item = ranges.find(x => x.key === range.value); return item?.ms == null ? startOfToday() : Date.now() - item.ms }
function isError(row) { const status = Number(row.status); return !Number.isFinite(status) || status < 200 || status >= 400 }
function modelRows() {
  const since = cutoff()
  const grouped = new Map()
  for (const row of rows.value) {
    const at = Date.parse(row.at || '')
    if (!Number.isFinite(at) || at < since) continue
    const key = row.public_model || '(unknown)'
    const current = grouped.get(key) || { model: key, total: 0, errors: 0 }
    current.total += 1
    if (isError(row)) current.errors += 1
    grouped.set(key, current)
  }
  return [...grouped.values()].map(x => ({ ...x, rate: x.total ? x.errors / x.total * 100 : 0 })).sort((a, b) => b.errors - a.errors || b.total - a.total)
}
const stats = computed(modelRows)
const totalCalls = computed(() => stats.value.reduce((n, x) => n + x.total, 0))
const totalErrors = computed(() => stats.value.reduce((n, x) => n + x.errors, 0))
const totalRate = computed(() => totalCalls.value ? totalErrors.value / totalCalls.value * 100 : 0)
const maxErrors = computed(() => Math.max(1, ...stats.value.map(x => x.errors)))
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
const linePoints = computed(() => {
  const end = Date.now(); const start = end - 24 * 3600e3
  const buckets = Array.from({ length: 24 }, (_, i) => ({ at: start + i * 3600e3, total: 0, errors: 0 }))
  for (const row of rows.value) {
    const at = Date.parse(row.at || '')
    if (!Number.isFinite(at) || at < start || at > end) continue
    const index = Math.min(23, Math.max(0, Math.floor((at - start) / 3600e3)))
    buckets[index].total += 1
    if (isError(row)) buckets[index].errors += 1
  }
  return buckets.map((b, i) => ({ ...b, rate: b.total ? b.errors / b.total * 100 : 0, x: 8 + i * (84 / 23), y: 92 - (b.total ? b.errors / b.total * 100 : 0) * .84 }))
})
const linePath = computed(() => linePoints.value.map((p, i) => `${i ? 'L' : 'M'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' '))
function formatRate(n) { return `${n.toFixed(n >= 10 ? 0 : 1)}%` }
function formatHour(at) { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }
async function load() {
  loading.value = true
  try {
    const response = await fetch('/api/usage', { cache: 'no-store' })
    if (response.ok) usage.value = await response.json()
  } finally { loading.value = false }
}
onMounted(() => { load(); timer = window.setInterval(load, 10000) })
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <section class="card errors-panel">
    <div class="section-head">
      <div><h2>错误统计</h2><div class="hint">直接基于 Alasql 中记录的调用结果统计；4h / 12h / 24h / 今天 / 72h / 一周可切换。</div></div>
      <button class="btn secondary refresh-btn" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button>
    </div>

    <div class="range-tabs">
      <button v-for="item in ranges" :key="item.key" :class="{ active: range === item.key }" @click="range = item.key">{{ item.label }}</button>
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
    <div class="hint source-note">注：当前后端的 /api/usage 接口向前端返回最近 200 条调用记录，因此在高流量环境下，一周统计可能受这 200 条记录的返回上限影响。</div>
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
.chart-card { padding:16px; border:1px solid #e7e8ea; border-radius:12px; background:#fff; }.chart-title { font-size:13px; font-weight:700; margin-bottom:12px; }.pie-row { display:flex; align-items:center; gap:22px; min-height:210px; }.pie { width:180px; height:180px; flex:0 0 auto; border-radius:50%; }.legend { flex:1; min-width:0; }.legend div { display:grid; grid-template-columns:10px minmax(0,1fr) auto; align-items:center; gap:7px; margin:7px 0; font-size:12px; }.legend i { width:8px; height:8px; border-radius:50%; }.legend span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.line-chart { display:block; width:100%; height:210px; overflow:visible; }.grid { stroke:#eceef0; stroke-width:.35; }.line { fill:none; stroke:#17181a; stroke-width:1.5; vector-effect:non-scaling-stroke; }.dot { fill:#1677ff; vector-effect:non-scaling-stroke; }.axis { display:flex; justify-content:space-between; color:#999; font-size:10px; }.axis span:nth-child(2) { color:#777; }.bars-card { margin-top:14px; }.bars { display:flex; flex-direction:column; gap:10px; }.bar-row { display:grid; grid-template-columns:minmax(100px,180px) minmax(100px,1fr) 120px; align-items:center; gap:10px; font-size:12px; }.bar-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }.bar-track { height:18px; background:#f0f1f3; border-radius:5px; overflow:hidden; }.bar-fill { height:100%; min-width:2px; background:#e05252; border-radius:5px; }.bar-value { text-align:right; color:#666; font-variant-numeric:tabular-nums; }.chart-empty { display:flex; align-items:center; justify-content:center; min-height:180px; color:#999; font-size:13px; }.error-table { width:100%; margin-top:14px; border-collapse:collapse; font-size:12px; }.error-table th,.error-table td { padding:8px; border-bottom:1px solid #eef0f2; text-align:left; }.error-table th { color:#777; }.source-note { margin-top:10px; font-size:11px; }
@media(max-width:800px){.charts{grid-template-columns:1fr}.pie-row{justify-content:center}.bar-row{grid-template-columns:minmax(90px,1fr) minmax(80px,2fr);}.bar-value{text-align:left;grid-column:2}.error-summary{grid-template-columns:1fr 1fr 1fr}.pie{width:150px;height:150px}}
</style>
