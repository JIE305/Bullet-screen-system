<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { damuApi, isBrowserPreview } from './api'
import type { AppState, CaptureSourceInfo, EventEnvelope } from '../../shared/contracts'
import {
  DEFAULT_ROI,
  type PreprocessMode,
  type RoiSettings
} from '../../shared/capture-settings'
import {
  DEFAULT_EVENT_LOG_FILTER,
  clearEvents,
  filterEvents,
  getEventSummary,
  prependEvent,
  removeEvent as removeEventFromLog,
  type EventLogFilter
} from '../../shared/event-log'
import OverlayStyleDrawer from './OverlayStyleDrawer.vue'
import CloudApiDrawer from './CloudApiDrawer.vue'
import {
  cloneDefaultCloudApiSettings,
  type CloudApiPublicSettings,
  type CloudApiRuntimeState
} from '../../shared/cloud-api'

const state = ref<AppState>({
  backend: 'starting',
  connection: 'disconnected',
  session: 'idle',
  framesAccepted: 0,
  framesDropped: 0
})
const sources = ref<CaptureSourceInfo[]>([])
const selectedSourceId = ref('')
const gameName = ref('')
const roi = ref<RoiSettings>({ ...DEFAULT_ROI })
const preprocessMode = ref<PreprocessMode>('original')
const busy = ref(false)
const loadingSources = ref(false)
const localError = ref('')
const eventLog = ref<EventEnvelope[]>([])
// The primary view mirrors what is actually sent to the overlay. Diagnostic
// recognition/status events remain available through the "全部" filter.
const eventFilter = ref<EventLogFilter>(DEFAULT_EVENT_LOG_FILTER)
const copyStatus = ref('')
const styleDrawerOpen = ref(false)
const styleTrigger = ref<HTMLButtonElement>()
const cloudDrawerOpen = ref(false)
const cloudTrigger = ref<HTMLButtonElement>()
const cloudSettings = ref(cloneDefaultCloudApiSettings())
const cloudState = ref<CloudApiRuntimeState>({ status: 'unconfigured' })
let disposeState: (() => void) | undefined
let disposeEvents: (() => void) | undefined
let disposeCloudState: (() => void) | undefined
let copyStatusTimer: number | undefined
let roiPointerId: number | undefined
let roiStart: { x: number; y: number } | undefined

const selectedSource = computed(() =>
  sources.value.find((source) => source.id === selectedSourceId.value)
)
const roiStyle = computed(() => ({
  left: `${roi.value.x * 100}%`,
  top: `${roi.value.y * 100}%`,
  width: `${roi.value.width * 100}%`,
  height: `${roi.value.height * 100}%`
}))

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
const cloudStatusLabel = computed(() => ({
  unconfigured: '未配置',
  disabled: '已停用',
  ready: '就绪',
  calling: '调用中',
  rate_limited: '已限流',
  error: '失败'
})[cloudState.value.status])
const canEnableCloud = computed(() =>
  Boolean(cloudSettings.value.hasApiKey && cloudSettings.value.baseUrl && cloudSettings.value.model)
)
const policyDraft = ref({
  minConfidence: cloudSettings.value.minConfidence,
  minIntervalMs: cloudSettings.value.minIntervalMs,
  repeatCooldownMs: cloudSettings.value.repeatCooldownMs,
  maxCallsPerMinute: cloudSettings.value.maxCallsPerMinute
})
const savedPolicy = ref({ ...policyDraft.value })
const policyDirty = computed(() => JSON.stringify(policyDraft.value) !== JSON.stringify(savedPolicy.value))

watch(selectedSourceId, async (sourceId) => {
  if (!sourceId || state.value.session !== 'idle') return
  gameName.value = sources.value.find((source) => source.id === sourceId)?.name ?? ''
  roi.value = { ...DEFAULT_ROI }
  preprocessMode.value = 'original'
  try {
    const saved = await damuApi.getCaptureSettings(sourceId)
    if (!saved || selectedSourceId.value !== sourceId) return
    gameName.value = saved.gameName || gameName.value
    roi.value = { ...saved.region }
    preprocessMode.value = saved.preprocessMode
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  }
})

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

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function normalizeRoi(): void {
  const x = clamp(Number(roi.value.x) || 0, 0, 0.98)
  const y = clamp(Number(roi.value.y) || 0, 0, 0.98)
  roi.value = {
    x,
    y,
    width: clamp(Number(roi.value.width) || 0.02, 0.02, 1 - x),
    height: clamp(Number(roi.value.height) || 0.02, 0.02, 1 - y)
  }
}

function roiPoint(event: PointerEvent): { x: number; y: number } {
  const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
  return {
    x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
    y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1)
  }
}

function beginRoi(event: PointerEvent): void {
  if (state.value.session !== 'idle') return
  roiPointerId = event.pointerId
  roiStart = roiPoint(event)
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  roi.value = { x: roiStart.x, y: roiStart.y, width: 0.02, height: 0.02 }
}

function updateRoi(event: PointerEvent): void {
  if (event.pointerId !== roiPointerId || !roiStart) return
  const point = roiPoint(event)
  const x = Math.min(roiStart.x, point.x)
  const y = Math.min(roiStart.y, point.y)
  roi.value = {
    x,
    y,
    width: Math.max(0.02, Math.abs(point.x - roiStart.x)),
    height: Math.max(0.02, Math.abs(point.y - roiStart.y))
  }
  normalizeRoi()
}

function endRoi(event: PointerEvent): void {
  if (event.pointerId !== roiPointerId) return
  updateRoi(event)
  roiPointerId = undefined
  roiStart = undefined
}

async function startSelectedSource(): Promise<void> {
  normalizeRoi()
  await damuApi.startSource({
    sourceId: selectedSourceId.value,
    gameName: gameName.value.trim(),
    region: { ...roi.value },
    preprocessMode: preprocessMode.value
  })
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

function openCloudDrawer(): void {
  cloudDrawerOpen.value = true
}

async function closeCloudDrawer(): Promise<void> {
  cloudDrawerOpen.value = false
  await nextTick()
  cloudTrigger.value?.focus()
}

function applyCloudSettings(settings: CloudApiPublicSettings): void {
  cloudSettings.value = { ...settings }
  policyDraft.value = {
    minConfidence: settings.minConfidence,
    minIntervalMs: settings.minIntervalMs,
    repeatCooldownMs: settings.repeatCooldownMs,
    maxCallsPerMinute: settings.maxCallsPerMinute
  }
  savedPolicy.value = { ...policyDraft.value }
}

function updatePolicyMilliseconds(
  key: 'minIntervalMs' | 'repeatCooldownMs',
  event: Event
): void {
  policyDraft.value[key] = Math.round(Number((event.target as HTMLInputElement).value) * 1000)
}

async function saveGenerationPolicy(): Promise<void> {
  if (state.value.session !== 'idle') throw new Error('请先停止当前会话，再保存生成策略')
  const saved = await damuApi.saveCloudApiSettings({
    enabled: cloudSettings.value.enabled,
    baseUrl: cloudSettings.value.baseUrl,
    model: cloudSettings.value.model,
    systemPrompt: cloudSettings.value.systemPrompt,
    timeoutMs: cloudSettings.value.timeoutMs,
    ...policyDraft.value
  })
  applyCloudSettings(saved)
}

async function toggleCloudEnabled(): Promise<void> {
  if (!cloudSettings.value.enabled && !canEnableCloud.value) {
    openCloudDrawer()
    return
  }
  const saved = await damuApi.saveCloudApiSettings({
    enabled: !cloudSettings.value.enabled,
    baseUrl: cloudSettings.value.baseUrl,
    model: cloudSettings.value.model,
    systemPrompt: cloudSettings.value.systemPrompt,
    timeoutMs: cloudSettings.value.timeoutMs,
    minConfidence: cloudSettings.value.minConfidence,
    minIntervalMs: cloudSettings.value.minIntervalMs,
    repeatCooldownMs: cloudSettings.value.repeatCooldownMs,
    maxCallsPerMinute: cloudSettings.value.maxCallsPerMinute
  })
  applyCloudSettings(saved)
}

onMounted(async () => {
  state.value = await damuApi.getState()
  disposeState = damuApi.onState((next) => {
    state.value = next
  })
  disposeEvents = damuApi.onEvent((event) => {
    eventLog.value = prependEvent(eventLog.value, event)
  })
  disposeCloudState = damuApi.onCloudApiState((next) => {
    cloudState.value = next
  })
  try {
    const [, cloud] = await Promise.all([
      refreshSources(),
      damuApi.getCloudApiSettings()
    ])
    applyCloudSettings(cloud)
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  }
})

onUnmounted(() => {
  disposeState?.()
  disposeEvents?.()
  disposeCloudState?.()
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

      <section class="generation-policy" aria-labelledby="generation-policy-title">
        <header>
          <span class="label">AI GENERATION POLICY</span>
          <h2 id="generation-policy-title">AI 弹幕生成策略</h2>
        </header>
        <div class="policy-fields" data-testid="generation-policy">
          <label>
            <span>最低 OCR 置信度</span>
            <input v-model.number="policyDraft.minConfidence" type="number" min="0.5" max="1" step="0.05" :disabled="state.session !== 'idle'" />
          </label>
          <label>
            <span>最小调用间隔</span>
            <span class="policy-value"><input :value="policyDraft.minIntervalMs / 1000" type="number" min="5" max="60" step="1" :disabled="state.session !== 'idle'" @input="updatePolicyMilliseconds('minIntervalMs', $event)" /><b>秒</b></span>
          </label>
          <label>
            <span>相同文字冷却</span>
            <span class="policy-value"><input :value="policyDraft.repeatCooldownMs / 1000" type="number" min="10" max="300" step="1" :disabled="state.session !== 'idle'" @input="updatePolicyMilliseconds('repeatCooldownMs', $event)" /><b>秒</b></span>
          </label>
          <label>
            <span>每分钟调用上限</span>
            <span class="policy-value"><input v-model.number="policyDraft.maxCallsPerMinute" type="number" min="1" max="12" step="1" :disabled="state.session !== 'idle'" /><b>次</b></span>
          </label>
        </div>
        <p>每帧最多选择一段文字。AI 未配置或调用受限时只记录 OCR，不生成弹幕。</p>
        <button
          type="button"
          data-testid="generation-policy-save"
          :disabled="state.session !== 'idle' || busy || !policyDirty"
          @click="run(saveGenerationPolicy)"
        >{{ policyDirty ? '保存生成策略' : '策略已保存' }}</button>
      </section>

      <section class="cloud-card" aria-labelledby="cloud-card-title">
        <div class="cloud-card-head">
          <span id="cloud-card-title">CLOUD GENERATOR</span>
          <i :class="cloudState.status" aria-hidden="true"></i>
        </div>
        <strong>{{ cloudStatusLabel }}</strong>
        <p :title="cloudSettings.model || '尚未配置模型'">{{ cloudSettings.model || 'NO MODEL CONFIGURED' }}</p>
        <small v-if="cloudState.lastLatencyMs !== undefined">LAST · {{ Math.round(cloudState.lastLatencyMs) }} MS</small>
        <small v-else>OCR-DIRECT · TEXT ONLY</small>
        <div class="cloud-card-actions">
          <button
            type="button"
            :disabled="state.session !== 'idle' || busy"
            @click="run(toggleCloudEnabled)"
          >{{ cloudSettings.enabled ? '停用' : '启用' }}</button>
          <button ref="cloudTrigger" data-testid="cloud-config-trigger" type="button" @click="openCloudDrawer">配置</button>
        </div>
      </section>
      <div v-if="isBrowserPreview" class="preview-flag">BROWSER PREVIEW</div>
    </aside>

    <main class="workspace">
      <header class="topbar">
        <div>
          <p class="kicker">CAPTURE SESSION / CONTROL</p>
          <h1>捕获会话</h1>
        </div>
        <div class="topbar-actions">
          <button ref="styleTrigger" class="style-trigger" type="button" data-testid="style-trigger" @click="openStyleDrawer">弹幕样式</button>
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

          <label class="game-name-field">
            <span>
              <b>游戏名称候选</b>
              <small>可修改确认；仅该名称会随选中的 OCR 文字发送给云端</small>
            </span>
            <input
              v-model="gameName"
              maxlength="120"
              :disabled="state.session !== 'idle' || !selectedSourceId"
              placeholder="例如：英雄联盟（留空时生成通用弹幕）"
            />
          </label>

          <div class="capture-setup">
            <section class="roi-config" aria-labelledby="roi-heading">
              <div class="setup-heading">
                <div><span class="label">02 / REGION</span><h3 id="roi-heading">识别区域</h3></div>
                <label class="preprocess-field compact"><span>当前窗口预处理</span><select v-model="preprocessMode" :disabled="state.session !== 'idle'"><option value="original">原始画面</option><option value="high_contrast">高对比度</option></select></label>
              </div>
              <div
                class="roi-canvas"
                :class="{ disabled: state.session !== 'idle' }"
                @pointerdown="beginRoi"
                @pointermove="updateRoi"
                @pointerup="endRoi"
                @pointercancel="endRoi"
              >
                <img v-if="selectedSource?.thumbnail" :src="selectedSource.thumbnail" alt="所选窗口预览" draggable="false" />
                <span v-else>WINDOW PREVIEW</span>
                <i class="roi-selection" :style="roiStyle"><b>ROI</b></i>
              </div>
              <div class="roi-values">
                <label v-for="key in (['x', 'y', 'width', 'height'] as const)" :key="key">
                  <span>{{ key === 'width' ? 'W' : key === 'height' ? 'H' : key.toUpperCase() }}</span>
                  <input v-model.number="roi[key]" type="number" min="0" max="1" step="0.01" :disabled="state.session !== 'idle'" @change="normalizeRoi" />
                </label>
              </div>
            </section>

          </div>

          <div class="action-bar">
            <button
              class="primary-button"
              :disabled="!canStart || !selectedSourceId"
              @click="run(startSelectedSource)"
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
    <CloudApiDrawer
      :open="cloudDrawerOpen"
      :settings="cloudSettings"
      :session-active="state.session !== 'idle'"
      @close="closeCloudDrawer"
      @saved="applyCloudSettings"
    />
  </div>
</template>
