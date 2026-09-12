<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
const sessions = ref([]), selected = ref(null), loading = ref(false)
let timer
const current = computed(() => sessions.value.find(x => x.id === selected.value) || sessions.value[0])
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN') : '—' }
async function load() {
  loading.value = true
  try { const r = await fetch('/api/response-sessions', { cache: 'no-store' }); if (r.ok) { sessions.value = await r.json(); if (!selected.value && sessions.value[0]) selected.value = sessions.value[0].id } } finally { loading.value = false }
}
onMounted(() => { load(); timer = setInterval(load, 2000) })
onBeforeUnmount(() => clearInterval(timer))
</script>
<template>
  <section class="card sessions-panel">
    <div class="section-head"><div><h2>Responses 会话</h2><div class="hint">记录通过 Chat Completions 代理的最近 100 次 Responses 请求。</div></div><button class="btn secondary" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button></div>
    <div v-if="!sessions.length" class="empty">暂无会话记录。</div>
    <div v-else class="sessions-layout">
      <div class="session-list">
        <button v-for="item in sessions" :key="item.id" class="session-item" :class="{ active: current?.id === item.id }" @click="selected = item.id">
          <strong>{{ item.model || '未命名模型' }}</strong><span>{{ formatTime(item.at) }}</span><small>{{ item.status }} · {{ item.upstream_model || '—' }}</small>
        </button>
      </div>
      <div v-if="current" class="session-detail">
        <div class="detail-head"><strong>{{ current.model }}</strong><span>{{ current.status }} · {{ formatTime(current.at) }}</span></div>
        <div class="json-columns"><div><h3>收到的 Responses 请求</h3><pre>{{ JSON.stringify(current.request, null, 2) }}</pre></div><div><h3>发出的 Chat Completions 请求</h3><pre>{{ JSON.stringify(current.chat_request, null, 2) }}</pre></div></div>
      </div>
    </div>
  </section>
</template>
<style scoped>
.sessions-layout { display: grid; grid-template-columns: 270px 1fr; gap: 14px; margin-top: 18px; min-height: 420px; }
.session-list { display: flex; flex-direction: column; gap: 6px; max-height: 600px; overflow: auto; }
.session-item { display: flex; flex-direction: column; gap: 3px; padding: 11px; border: 1px solid #e3e5e8; border-radius: 9px; background: #fafbfc; color: #222; text-align: left; cursor: pointer; }
.session-item:hover, .session-item.active { border-color: #1677ff; background: #eef6ff; }
.session-item span, .session-item small, .detail-head span { color: #777; font-size: 12px; }
.session-detail { min-width: 0; }.detail-head { display:flex; justify-content:space-between; gap:10px; margin-bottom: 10px; }
.json-columns { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }.json-columns h3 { margin: 0 0 7px; font-size: 14px; }.json-columns pre { min-height: 360px; max-height: 600px; overflow: auto; margin: 0; padding: 12px; border-radius: 9px; background: #f6f7f9; font: 12px/1.5 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 850px) { .sessions-layout, .json-columns { grid-template-columns: 1fr; } .session-list { max-height: 240px; } }
</style>