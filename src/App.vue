<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

const emptyEntry = () => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
  public_model: '',
  url: '',
  key: '',
  upstream_model: '',
  use_proxy: true,
  proxy_from_chat_completions: false,
  enabled: true,
})

const state = reactive({ chat_completions: [], responses: [] })
const savedState = ref({ chat_completions: [], responses: [] })
const stats = ref({ chat_completions: [], responses: [] })
const loading = ref(true)
const statsLoading = ref(true)
const saving = ref(false)
const message = ref('')
const error = ref('')
let timer

const rows = computed(() => [
  { key: 'chat_completions', title: 'Chat Completions' },
  { key: 'responses', title: 'Responses' },
])

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function snapshot(entry) {
  return {
    id: entry.id,
    public_model: entry.public_model,
    url: entry.url,
    key: entry.key,
    upstream_model: entry.upstream_model,
    use_proxy: entry.use_proxy,
    proxy_from_chat_completions: entry.proxy_from_chat_completions,
    enabled: entry.enabled,
  }
}

function isSaved(type, entry) {
  const old = savedState.value[type]?.find((item) => item.id === entry.id)
  return !!old && JSON.stringify(snapshot(old)) === JSON.stringify(snapshot(entry))
}

function addRow(type) {
  state[type].push(emptyEntry())
}

function deleteRow(type, index) {
  state[type].splice(index, 1)
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const response = await fetch('/api/config')
    if (!response.ok) throw new Error('配置加载失败')
    const data = await response.json()
    state.chat_completions = data.chat_completions || []
    state.responses = data.responses || []
    savedState.value = clone(state)
  } catch (err) {
    error.value = err.message || '配置加载失败'
  } finally {
    loading.value = false
  }
}

async function save() {
  saving.value = true
  try {
    const response = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state),
    })
    if (!response.ok) throw new Error('保存失败')
    const data = await response.json()
    state.chat_completions = data.chat_completions || []
    state.responses = data.responses || []
    savedState.value = clone(state)
    flash('配置已保存')
  } catch (err) {
    flash(err.message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function loadStats() {
  statsLoading.value = true
  try {
    const response = await fetch('/api/metrics')
    if (!response.ok) throw new Error()
    stats.value = await response.json()
  } catch {
    stats.value = { chat_completions: [], responses: [] }
  } finally {
    statsLoading.value = false
  }
}

async function clearStats() {
  if (!window.confirm('确定清空所有调用统计？')) return
  const response = await fetch('/api/metrics', { method: 'DELETE' })
  if (response.ok) {
    await loadStats()
    flash('统计已清空')
  } else {
    flash('清空失败')
  }
}

function flash(text) {
  message.value = text
  window.setTimeout(() => {
    message.value = ''
  }, 1800)
}

function speed(sample) {
  if (sample.tokens_per_second != null) return `${sample.tokens_per_second} tok/s`
  if (sample.chars_per_second != null) return `${sample.chars_per_second} 字符/s`
  return '—'
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : '—'
}

onMounted(async () => {
  await Promise.all([load(), loadStats()])
  timer = window.setInterval(loadStats, 10000)
})

onUnmounted(() => window.clearInterval(timer))
</script>

<template>
  <main class="shell">
    <header class="hero">
      <div>
        <div class="eyebrow">LLM PROXY</div>
        <h1>统一管理你的模型入口</h1>
        <p>把多个 OpenAI-compatible 接口汇集到统一的 <code>/v1</code> 地址，并实时查看流式调用指标。</p>
      </div>
      <div class="hero-badge">Vue 3 · Vite</div>
    </header>

    <section class="card stats-card">
      <div class="section-head">
        <div>
          <h2>调用统计</h2>
          <p>TTFT = 请求发出到收到第一个文本增量；生成速度优先使用上游返回的 token usage，否则使用字符/秒。</p>
        </div>
        <button class="button secondary" :disabled="statsLoading" @click="loadStats">刷新</button>
      </div>

      <div v-if="statsLoading" class="empty">加载中…</div>
      <div v-else-if="!stats.chat_completions?.length && !stats.responses?.length" class="empty">暂无配置或统计数据。</div>
      <div v-else class="stats-grid">
        <template v-for="type in ['chat_completions', 'responses']" :key="type">
          <article v-for="item in stats[type] || []" :key="`${type}-${item.public_model}`" class="stat-card">
            <div class="stat-title">
              <strong>{{ item.public_model }}</strong>
              <span>{{ type === 'responses' ? 'Responses' : 'Chat Completions' }}<template v-if="item.upstream_model !== item.public_model"> · {{ item.upstream_model }}</template></span>
            </div>
            <table v-if="item.samples?.length">
              <thead><tr><th>时间</th><th>首字时间</th><th>生成速度</th></tr></thead>
              <tbody>
                <tr v-for="sample in [...item.samples].reverse()" :key="sample.timestamp">
                  <td>{{ formatTime(sample.timestamp) }}</td>
                  <td>{{ sample.ttft_ms ?? '—' }} ms</td>
                  <td>{{ speed(sample) }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else class="stat-empty">暂无流式调用数据。实际调用一次后会自动出现。</div>
          </article>
        </template>
      </div>
      <div class="section-actions">
        <button class="button danger" @click="clearStats">清空统计</button>
      </div>
    </section>

    <section v-for="section in rows" :key="section.key" class="card">
      <div class="section-head compact">
        <div>
          <h2>{{ section.title }}</h2>
          <p>公开模型名 → 上游地址 / Key / 上游模型名 / SOCKS5 代理</p>
        </div>
        <button class="button secondary" @click="addRow(section.key)">＋ 添加</button>
      </div>

      <div v-if="loading" class="empty">加载中…</div>
      <div v-else-if="!state[section.key].length" class="empty">还没有配置。</div>
      <div v-else class="config-list">
        <div v-for="(entry, index) in state[section.key]" :key="entry.id" class="config-row" :class="{ unchanged: isSaved(section.key, entry) }">
          <input v-model="entry.public_model" placeholder="公开模型名，如 gpt-4" />
          <input v-model="entry.url" placeholder="接口地址，如 https://.../v1/chat/completions" />
          <input v-model="entry.key" type="password" placeholder="API Key" />
          <input v-model="entry.upstream_model" placeholder="上游模型名" />
          <label class="check"><input v-model="entry.use_proxy" type="checkbox" /> SOCKS5</label>
          <label v-if="section.key === 'responses'" class="check"><input v-model="entry.proxy_from_chat_completions" type="checkbox" /> 从 Chat Completions 代理</label>
          <button class="icon-button" title="删除" @click="deleteRow(section.key, index)">删除</button>
        </div>
      </div>
    </section>

    <div class="bottom-actions">
      <button class="button primary" :disabled="saving || loading" @click="save">{{ saving ? '保存中…' : '保存配置' }}</button>
      <button class="button secondary" :disabled="loading" @click="load">重新加载</button>
    </div>

    <p v-if="error" class="error-banner">{{ error }}</p>
    <Transition name="toast"><div v-if="message" class="toast">{{ message }}</div></Transition>
  </main>
</template>
