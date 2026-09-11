<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  configs: { type: Object, required: true },
  savedConfigs: { type: Object, required: true },
  types: { type: Array, required: true },
})

const emit = defineEmits(['notice'])
const results = ref([])
const benchmarkRunning = ref(false)
const live = ref(null)

function makeBenchmarkSuffix() {
  return String(Math.floor(Math.random() * 100000)).padStart(5, '0')
}

function makeBenchmarkPrompt(suffix) {
  return `请补全下面的 JavaScript 代码。类名中的 5 位数字是本次测试随机生成的标识，请保持这个类名完全不变，不要修改、解释或省略它。请实现一个完整、可用的红黑树（Red-Black Tree）数据结构，并提供插入、删除、查找以及中序遍历/排序功能。只输出完整 JavaScript 代码，不要 Markdown 代码围栏、说明文字或前言。代码必须从下面这行开始，并补全为完整实现：\n\nclass RBTree${suffix} {}`
}

const hasConfigs = computed(() => props.types.some(({ key }) => props.configs[key].some(x => x.enabled !== false && x.public_model && x.url)))

function snapshot(x) {
  return { id: x.id, public_model: x.public_model, url: x.url, key: x.key, upstream_model: x.upstream_model, use_proxy: x.use_proxy, proxy_from_chat_completions: x.proxy_from_chat_completions, enabled: x.enabled }
}
function isSaved(type, x) {
  const old = props.savedConfigs[type].find(y => y.id === x.id)
  return !!old && JSON.stringify(snapshot(old)) === JSON.stringify(snapshot(x))
}
function formatMs(value) { return value == null ? '—' : `${value} ms` }
function formatSpeed(row) {
  if (row.tokens_per_second != null) return `${row.tokens_per_second} tok/s`
  if (row.chars_per_second != null) return `${row.chars_per_second} 字符/s`
  return '—'
}
function updateLive(patch) { live.value = { ...(live.value || {}), ...patch } }

async function streamBenchmark(type, model) {
  const suffix = makeBenchmarkSuffix()
  const prompt = makeBenchmarkPrompt(suffix)
  const startedAt = performance.now()
  let firstTextAt = null
  let text = ''
  let buffer = ''
  let usage = null
  const body = type === 'responses'
    ? { model, input: prompt, stream: true, max_output_tokens: 1500 }
    : { model, messages: [{ role: 'user', content: prompt }], stream: true, max_tokens: 1500 }

  updateLive({ type, model, suffix, status: `随机前缀 RBTree${suffix}，等待返回首字`, text: '' })
  const response = await fetch(type === 'responses' ? '/v1/responses' : '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body),
  })
  if (!response.ok) {
    let message = `HTTP ${response.status}`
    try { message = (await response.json()).error?.message || message } catch {}
    throw new Error(message)
  }
  if (!response.body) throw new Error('浏览器不支持流式响应')
  updateLive({ status: `已连接，等待 RBTree${suffix} 返回首字` })

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const consume = chunk => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      let data
      try { data = JSON.parse(raw) } catch { continue }
      if (data.usage) usage = data.usage
      let delta = ''
      if (type === 'responses') {
        if (typeof data.delta === 'string' && String(data.type || '').includes('output_text')) delta = data.delta
        else if (typeof data.output_text?.delta === 'string') delta = data.output_text.delta
      } else if (typeof data.choices?.[0]?.delta?.content === 'string') delta = data.choices[0].delta.content
      if (!delta) continue
      if (firstTextAt === null) {
        firstTextAt = performance.now()
        updateLive({ status: '已返回首字，正在流式生成', ttft_ms: Math.round(firstTextAt - startedAt) })
      }
      text += delta
      updateLive({ status: '流式返回中', text: text.slice(-240) })
    }
  }

  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    consume(decoder.decode(value, { stream: true }))
  }
  consume(decoder.decode())
  const finishedAt = performance.now()
  const generationMs = firstTextAt == null ? null : finishedAt - firstTextAt
  const completionTokens = usage?.completion_tokens ?? usage?.output_tokens ?? null
  const chars = [...text].length
  return {
    ok: true, status: response.status, type, model, benchmark_suffix: suffix, prompt, text,
    ttft_ms: firstTextAt == null ? null : Math.round(firstTextAt - startedAt),
    total_ms: Math.round(finishedAt - startedAt),
    generated_chars: chars,
    completion_tokens: completionTokens,
    chars_per_second: generationMs && chars ? Math.round(chars / (generationMs / 1000) * 10) / 10 : null,
    tokens_per_second: completionTokens != null && generationMs > 0 ? Math.round(completionTokens / (generationMs / 1000) * 10) / 10 : null,
  }
}

async function testAll() {
  if (benchmarkRunning.value) return
  benchmarkRunning.value = true
  results.value = []
  live.value = null
  const entries = []
  for (const type of props.types.map(x => x.key)) {
    for (const row of props.configs[type]) {
      if (row.enabled === false || !row.public_model || !row.url || !isSaved(type, row)) continue
      entries.push({ type, model: row.public_model, upstream_model: row.upstream_model || row.public_model })
    }
  }
  try {
    for (const item of entries) {
      const running = { ...item, running: true }
      results.value.push(running)
      try {
        const result = await streamBenchmark(item.type, item.model)
        const index = results.value.indexOf(running)
        if (index >= 0) results.value.splice(index, 1, { ...result, upstream_model: item.upstream_model })
      } catch (error) {
        const index = results.value.indexOf(running)
        if (index >= 0) results.value.splice(index, 1, { ...item, ok: false, error: error.message, running: false })
      }
    }
    emit('notice', '所有配置测试完成')
  } finally {
    live.value = null
    benchmarkRunning.value = false
  }
}
</script>

<template>
  <section class="card benchmark">
    <div class="section-head">
      <div><h2>模型性能测试</h2><div class="hint">每次测试为类名随机生成 5 位数字，要求模型补全红黑树 JavaScript 代码，以避免固定前缀缓存影响 TTFT。</div></div>
      <button class="btn" :disabled="benchmarkRunning || !hasConfigs" @click="testAll">{{ benchmarkRunning ? '测试中…' : '测试所有配置' }}</button>
    </div>
    <div v-if="live" class="bench-live"><strong>正在测试 {{ live.model }}</strong><div>{{ live.status }}</div><small v-if="live.suffix">随机类名：RBTree{{ live.suffix }}</small><small v-if="live.text">{{ live.text }}</small></div>
    <div v-if="!results.length" class="empty">{{ benchmarkRunning ? '准备测试…' : '点击按钮开始测试。' }}</div>
    <div v-else class="table-wrap">
      <table class="bench-table">
        <thead><tr><th>类型</th><th>模型</th><th>状态</th><th>随机前缀</th><th>首字延迟</th><th>生成速度</th><th>生成量</th><th>总耗时</th><th>回复</th></tr></thead>
        <tbody>
          <tr v-for="(result, index) in results" :key="`${result.type}:${result.model}:${index}`">
            <td>{{ result.type === 'responses' ? 'Responses' : 'Chat Completions' }}</td>
            <td><strong>{{ result.model }}</strong><div v-if="result.upstream_model && result.upstream_model !== result.model" class="hint">→ {{ result.upstream_model }}</div></td>
            <td :class="result.running ? 'bench-running' : result.ok ? 'bench-ok' : 'bench-error'">{{ result.running ? '测试中…' : result.ok ? '完成' : '失败' }}<span v-if="result.status"> · HTTP {{ result.status }}</span><div v-if="result.error">{{ result.error }}</div></td>
            <td class="metric">{{ result.benchmark_suffix ? `RBTree${result.benchmark_suffix}` : '—' }}</td>
            <td class="metric">{{ formatMs(result.ttft_ms) }}</td><td class="metric">{{ formatSpeed(result) }}<span v-if="result.completion_tokens != null" class="hint"> ({{ result.completion_tokens }} tok)</span></td>
            <td class="metric">{{ result.generated_chars != null ? `${result.generated_chars} 字符` : '—' }}</td><td class="metric">{{ formatMs(result.total_ms) }}</td><td><div class="bench-text">{{ result.text || '' }}</div></td>
          </tr>
        </tbody>
      </table>
      <div class="bench-summary">已完成 {{ results.filter(x => !x.running).length }} 个配置<span v-if="results.some(x => !x.running && !x.ok)">，失败 {{ results.filter(x => !x.running && !x.ok).length }} 个</span>。TTFT 从请求发出开始计算，且每次请求使用新的随机 5 位类名。</div>
    </div>
  </section>
</template>
