<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
const sessions = ref([]), selectedConversation = ref(null), selectedSession = ref(null), loading = ref(false)
let timer
const conversations = computed(() => { const groups = new Map(); for (const item of sessions.value) { if (!groups.has(item.conversation_id)) groups.set(item.conversation_id, []); groups.get(item.conversation_id).push(item) }; return [...groups.values()].map(items => ({ id: items[0].conversation_id, model: items[0].model, items: items.sort((a, b) => new Date(a.at) - new Date(b.at)) })).reverse() })
const conversation = computed(() => conversations.value.find(x => x.id === selectedConversation.value) || conversations.value[0])
const current = computed(() => conversation.value?.items.find(x => x.id === selectedSession.value) || conversation.value?.items.at(-1))
function formatTime(value) { return value ? new Date(value).toLocaleString('zh-CN') : '—' }
async function load() { loading.value = true; try { const r = await fetch('/api/response-sessions', { cache: 'no-store' }); if (r.ok) { sessions.value = await r.json(); if (!selectedConversation.value && conversations.value[0]) selectedConversation.value = conversations.value[0].id; if (!selectedSession.value && conversation.value?.items[0]) selectedSession.value = conversation.value.items[0].id } } finally { loading.value = false } }
onMounted(() => { load(); timer = setInterval(load, 2000) })
onBeforeUnmount(() => clearInterval(timer))
</script>
<template>
  <section class="card sessions-panel">
    <div class="section-head"><div><h2>Responses 会话</h2><div class="hint">按 conversation_id 查看多轮请求及每一轮的转换详情。</div></div><button class="btn secondary" :disabled="loading" @click="load">{{ loading ? '刷新中…' : '刷新' }}</button></div>
    <div v-if="!sessions.length" class="empty">暂无会话记录。</div>
    <div v-else class="sessions-layout">
      <div class="session-list"><button v-for="group in conversations" :key="group.id" class="session-item" :class="{ active: conversation?.id === group.id }" @click="selectedConversation = group.id; selectedSession = group.items[0].id"><strong>{{ group.model || '未命名模型' }}</strong><span>{{ group.items.length }} 轮</span><small>{{ formatTime(group.items[0].at) }}</small></button></div>
      <div class="turn-list"><button v-for="item in conversation?.items || []" :key="item.id" class="turn-item" :class="{ active: current?.id === item.id }" @click="selectedSession = item.id"><strong>第 {{ item.turn }} 轮</strong><span>{{ formatTime(item.at) }}</span><small>{{ item.status }} · {{ item.response_id || '处理中' }}</small></button></div>
      <div v-if="current" class="session-detail"><div class="detail-head"><strong>{{ current.model }} · 第 {{ current.turn }} 轮</strong><span>{{ current.status }} · {{ formatTime(current.at) }}</span></div><div class="json-columns"><div><h3>收到的 Responses 请求</h3><pre>{{ JSON.stringify(current.request, null, 2) }}</pre></div><div><h3>发出的 Chat Completions 请求</h3><pre>{{ JSON.stringify(current.chat_request, null, 2) }}</pre></div></div></div>
    </div>
  </section>
</template>
<style scoped>
.sessions-layout { display:grid; grid-template-columns:220px 190px minmax(0,1fr); gap:14px; margin-top:18px; min-height:420px; }.session-list,.turn-list { display:flex; flex-direction:column; gap:6px; max-height:600px; overflow:auto; }.session-item,.turn-item { display:flex; flex-direction:column; gap:3px; padding:11px; border:1px solid #e3e5e8; border-radius:9px; background:#fafbfc; color:#222; text-align:left; cursor:pointer; }.session-item:hover,.session-item.active,.turn-item:hover,.turn-item.active { border-color:#1677ff; background:#eef6ff; }.session-item span,.turn-item span,.session-item small,.turn-item small,.detail-head span { color:#777; font-size:12px; }.session-detail { min-width:0; }.detail-head { display:flex; justify-content:space-between; gap:10px; margin-bottom:10px; }.json-columns { display:grid; grid-template-columns:1fr 1fr; gap:12px; }.json-columns h3 { margin:0 0 7px; font-size:14px; }.json-columns pre { min-height:360px; max-height:600px; overflow:auto; margin:0; padding:12px; border-radius:9px; background:#f6f7f9; font:12px/1.5 ui-monospace,monospace; white-space:pre-wrap; overflow-wrap:anywhere; }@media(max-width:1000px){.sessions-layout{grid-template-columns:1fr 1fr}.session-detail{grid-column:1/-1}}@media(max-width:650px){.sessions-layout,.json-columns{grid-template-columns:1fr}.session-list,.turn-list{max-height:240px}}
</style>