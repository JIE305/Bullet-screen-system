<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { damuApi, isBrowserPreview } from './api'
import type { AppState, CaptureSourceInfo, EventEnvelope } from '../../shared/contracts'
import {
  clearEvents,
  filterEvents,
  getEventSummary,
  prependEvent,
  removeEvent as removeEventFromLog,
  type EventLogFilter
} from '../../shared/event-log'
import OverlayStyleDrawer from './OverlayStyleDrawer.vue'

const state = ref<AppState>({
  backend: 'starting',
  connection: 'disconnected',
  session: 'idle',
  framesAccepted: 0,
  framesDropped: 0
})
const sources = ref<CaptureSourceInfo[]>([])
const selectedSourceId = ref('')
const busy = ref(false)
const loadingSources = ref(false)
const localError = ref('')
const eventLog = ref<EventEnvelope[]>([])
const eventFilter = ref<EventLogFilter>('all')
const copyStatus = ref('')
const styleDrawerOpen = ref(false)
const styleTrigger = ref<HTMLButtonElement>()
let disposeState: (() => void) | undefined
let disposeEvents: (() => void) | undefined
let copyStatusTimer: number | undefined

const filteredEvents = computed(() => filterEvents(eventLog.value, eventFilter.value))
const clearEventLabel = computed(() =>
  eventFilter.value === 'all' ? '清空全部' : '清空弹幕'
)
const emptyEventLabel = computed(() => {
  if (eventFilter.value === 'danmaku') return '暂无弹幕事件。'
  return eventLog.value.length === 0
    ? '启动测试链路后，后端事件将在这里出现。'
    : '暂无事件记录。'
})

const backendLabel = computed(() => {
  const labels: Record<AppState['backend'], string> = {
    starting: '启动中',
    online: '后端在线',
    offline: '后端离线',
    error: '后端异常'
  }
  return labels[state.value.backend]
})

const sessionLabel = computed(() => {
  const labels: Record<AppState['session'], string> = {
    idle: '等待启动',
    starting: '建立链路',
    running: '正在采集',
    stopping: '正在停止',
    error: '会话异常'
  }
  return labels[state.value.session]
})

const canStart = computed(
  () => state.value.backend === 'online' && state.value.session === 'idle' && !busy.value
)

async function run(action: () => Promise<void>): Promise<void> {
  busy.value = true
  localError.value = ''
  try {
    await action()
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  } finally {
    busy.value = false
  }
}

async function refreshSources(): Promise<void> {
  loadingSources.value = true
  localError.value = ''
  try {
    sources.value = await damuApi.listSources()
    if (!sources.value.some((source) => source.id === selectedSourceId.value)) {
      selectedSourceId.value = sources.value[0]?.id ?? ''
    }
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  } finally {
    loadingSources.value = false
  }
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value))
}

function setEventFilter(filter: EventLogFilter): void {
  eventFilter.value = filter
}

function removeEvent(eventId: string): void {
  eventLog.value = removeEventFromLog(eventLog.value, eventId)
}

function clearCurrentEvents(): void {
  eventLog.value = clearEvents(eventLog.value, eventFilter.value)
}

async function copyEventSummary(event: EventEnvelope): Promise<void> {
  localError.value = ''
  try {
    await damuApi.copyText(getEventSummary(event))
    copyStatus.value = '已复制'
    if (copyStatusTimer !== undefined) window.clearTimeout(copyStatusTimer)
    copyStatusTimer = window.setTimeout(() => {
      copyStatus.value = ''
      copyStatusTimer = undefined
    }, 1500)
  } catch (error) {
    copyStatus.value = ''
    localError.value = error instanceof Error ? error.message : String(error)
  }
}

function openStyleDrawer(): void {
  styleDrawerOpen.value = true
}

async function closeStyleDrawer(): Promise<void> {
  styleDrawerOpen.value = false
  await nextTick()
  styleTrigger.value?.focus()
}

onMounted(async () => {
  state.value = await damuApi.getState()
  disposeState = damuApi.onState((next) => {
    state.value = next
  })
  disposeEvents = damuApi.onEvent((event) => {
    eventLog.value = prependEvent(eventLog.value, event)
  })
  await refreshSources()
})

onUnmounted(() => {
  disposeState?.()
  disposeEvents?.()
  if (copyStatusTimer !== undefined) window.clearTimeout(copyStatusTimer)
})
</script>

<template>
  <div class="shell">
    <aside class="rail">
      <div class="brand-block">
        <div class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></div>
        <div>
          <strong>DaMu</strong>
          <span>LOCAL VISION BRIDGE</span>
        </div>
      </div>

      <nav class="step-nav" aria-label="开发阶段">
        <div class="step current">
          <span>01</span>
          <div><strong>通信链路</strong><small>WEEK 01 · ACTIVE</small></div>
        </div>
        <div class="step"><span>02</span><div><strong>视觉识别</strong><small>OCR · LOCKED</small></div></div>
        <div class="step"><span>03</span><div><strong>数据持久化</strong><small>SQLITE · LOCKED</small></div></div>
        <div class="step"><span>04</span><div><strong>打包验收</strong><small>RELEASE · LOCKED</small></div></div>
      </nav>

      <div class="rail-note">
        <span class="label">阶段边界</span>
        <p>当前使用 DummyRecognizer 与内存配置，真实 OCR 和数据库尚未启用。</p>
      </div>
      <div v-if="isBrowserPreview" class="preview-flag">BROWSER PREVIEW</div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div>
          <p class="kicker">CAPTURE SESSION / CONTROL</p>
          <h1>捕获会话</h1>
        </div>
        <div class="topbar-actions">
          <button ref="styleTrigger" class="style-trigger" type="button" @click="openStyleDrawer">弹幕样式</button>
          <div class="status-cluster" aria-label="系统状态">
            <span class="status" :class="state.backend"><i></i>{{ backendLabel }}</span>
            <span class="status" :class="state.connection"><i></i>WS {{ state.connection === 'connected' ? '已连接' : '未连接' }}</span>
          </div>
        </div>
      </header>

      <section v-if="localError || state.error" class="error-banner" role="alert">
        <span>ERR</span>
        <p>{{ localError || state.error }}</p>
      </section>

      <div class="content-grid">
        <section class="control-panel">
          <div class="section-heading">
            <div>
              <span class="label">01 / SOURCE</span>
              <h2>选择捕获窗口</h2>
            </div>
            <button class="text-button" :disabled="loadingSources" @click="refreshSources">
              {{ loadingSources ? '正在扫描' : '刷新窗口' }}
            </button>
          </div>

          <div v-if="loadingSources" class="source-state" aria-live="polite">
            <span class="scan-line"></span>
            正在枚举可捕获窗口…
          </div>
          <div v-else-if="sources.length === 0" class="source-state empty">
            没有可用窗口。请先打开一个窗口化应用，然后刷新列表。
          </div>
          <div v-else class="source-list" role="radiogroup" aria-label="可捕获窗口">
            <button
              v-for="source in sources"
              :key="source.id"
              class="source-row"
              :class="{ selected: selectedSourceId === source.id }"
              role="radio"
              :aria-checked="selectedSourceId === source.id"
              @click="selectedSourceId = source.id"
            >
              <span class="source-thumb">
                <img v-if="source.thumbnail" :src="source.thumbnail" alt="" />
                <span v-else>TEST SOURCE</span>
              </span>
              <span class="source-name"><strong>{{ source.name }}</strong><small>{{ source.id }}</small></span>
              <span class="selector" aria-hidden="true"></span>
            </button>
          </div>

          <div class="action-bar">
            <button
              class="primary-button"
              :disabled="!canStart || !selectedSourceId"
              @click="run(() => damuApi.startSource(selectedSourceId))"
            >
              启动所选窗口
            </button>
            <button class="secondary-button" :disabled="!canStart" @click="run(damuApi.startDemo)">
              启动内置测试链路
            </button>
            <button
              class="danger-button"
              :disabled="state.session === 'idle' || busy"
              @click="run(damuApi.stopSession)"
            >
              停止会话
            </button>
          </div>
        </section>

        <aside class="telemetry">
          <div class="telemetry-head">
            <span class="label">LIVE TELEMETRY</span>
            <span class="pulse" :class="state.session"></span>
          </div>
          <div class="session-readout">
            <span>SESSION STATE</span>
            <strong>{{ sessionLabel }}</strong>
            <small>{{ state.activeWindow || '尚未选择目标窗口' }}</small>
          </div>
          <dl class="metrics">
            <div><dt>接受帧</dt><dd>{{ String(state.framesAccepted).padStart(4, '0') }}</dd></div>
            <div><dt>丢弃帧</dt><dd>{{ String(state.framesDropped).padStart(4, '0') }}</dd></div>
            <div><dt>采样频率</dt><dd>1.0 <small>FPS</small></dd></div>
            <div><dt>队列上限</dt><dd>01 <small>FRAME</small></dd></div>
          </dl>
          <button class="outline-button" :disabled="busy" @click="run(damuApi.sendOverlayTest)">
            覆盖层自检
          </button>
        </aside>
      </div>

      <section class="event-strip">
        <div class="section-heading compact">
          <div><span class="label">EVENT STREAM</span><h2>最近事件</h2></div>
          <div class="event-tools" aria-label="最近事件管理">
            <div class="event-filters" aria-label="事件筛选">
              <button
                data-testid="event-filter-all"
                type="button"
                :aria-pressed="eventFilter === 'all'"
                @click="setEventFilter('all')"
              >全部</button>
              <button
                data-testid="event-filter-danmaku"
                type="button"
                :aria-pressed="eventFilter === 'danmaku'"
                @click="setEventFilter('danmaku')"
              >弹幕</button>
            </div>
            <span class="event-count">{{ filteredEvents.length }} / {{ eventLog.length }}</span>
            <span class="copy-status" role="status" aria-live="polite" data-testid="copy-status">{{ copyStatus }}</span>
            <button
              class="event-clear"
              data-testid="event-clear"
              type="button"
              :disabled="filteredEvents.length === 0"
              @click="clearCurrentEvents"
            >{{ clearEventLabel }}</button>
          </div>
        </div>
        <div v-if="filteredEvents.length === 0" class="empty-events" data-testid="event-empty">
          {{ emptyEventLabel }}
        </div>
        <ol v-else class="event-list" data-testid="event-list">
          <li
            v-for="event in filteredEvents"
            :key="event.event_id"
            data-testid="event-row"
            :data-event-type="event.type"
            :data-event-id="event.event_id"
          >
            <time>{{ formatTime(event.emitted_at) }}</time>
            <strong>{{ event.type }}</strong>
            <span class="event-summary" data-testid="event-summary" :title="getEventSummary(event)">
              {{ getEventSummary(event) }}
            </span>
            <span class="event-actions">
              <button
                data-testid="event-copy"
                type="button"
                :aria-label="`复制事件：${getEventSummary(event)}`"
                @click="copyEventSummary(event)"
              >复制</button>
              <button
                data-testid="event-remove"
                type="button"
                :aria-label="`移除事件：${getEventSummary(event)}`"
                @click="removeEvent(event.event_id)"
              >移除</button>
            </span>
          </li>
        </ol>
      </section>
    </main>
    <OverlayStyleDrawer :open="styleDrawerOpen" @close="closeStyleDrawer" />
  </div>
</template>
