<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { damuApi } from './api'
import {
  DEFAULT_CLOUD_SYSTEM_PROMPT,
  type CloudApiPublicSettings,
  type CloudApiSettingsUpdate
} from '../../shared/cloud-api'

const props = defineProps<{
  open: boolean
  settings: CloudApiPublicSettings
  sessionActive: boolean
}>()
const emit = defineEmits<{
  close: []
  saved: [settings: CloudApiPublicSettings]
}>()

const drawer = ref<HTMLElement>()
const closeButton = ref<HTMLButtonElement>()
const draft = ref<CloudApiSettingsUpdate>(toDraft(props.settings))
const apiKey = ref('')
const deleteApiKey = ref(false)
const busy = ref(false)
const error = ref('')

function toDraft(settings: CloudApiPublicSettings): CloudApiSettingsUpdate {
  return {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    timeoutMs: settings.timeoutMs,
    minConfidence: settings.minConfidence,
    minIntervalMs: settings.minIntervalMs,
    repeatCooldownMs: settings.repeatCooldownMs,
    maxCallsPerMinute: settings.maxCallsPerMinute
  }
}

function resetFromSettings(): void {
  draft.value = toDraft(props.settings)
  apiKey.value = ''
  deleteApiKey.value = false
  error.value = ''
}

async function save(): Promise<CloudApiPublicSettings> {
  if (props.sessionActive) throw new Error('请先停止当前会话，再修改云端 API 配置')
  const payload: CloudApiSettingsUpdate = {
    ...draft.value,
    ...(apiKey.value.trim() ? { apiKey: apiKey.value.trim() } : {}),
    ...(deleteApiKey.value ? { deleteApiKey: true, enabled: false } : {})
  }
  const saved = await damuApi.saveCloudApiSettings(payload)
  draft.value = toDraft(saved)
  apiKey.value = ''
  deleteApiKey.value = false
  emit('saved', saved)
  return saved
}

async function saveOnly(): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await save()
  } catch (caught) {
    error.value = caught instanceof Error ? caught.message : String(caught)
  } finally {
    busy.value = false
  }
}

function requestDeleteKey(): void {
  deleteApiKey.value = !deleteApiKey.value
  if (deleteApiKey.value) {
    apiKey.value = ''
    draft.value.enabled = false
  }
}

function restorePrompt(): void {
  draft.value.systemPrompt = DEFAULT_CLOUD_SYSTEM_PROMPT
}

function trapFocus(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  if (event.key !== 'Tab' || !drawer.value) return
  const elements = [...drawer.value.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )]
  if (!elements.length) return
  const first = elements[0]
  const last = elements[elements.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(() => props.settings, resetFromSettings, { deep: true })
watch(
  () => props.open,
  async (open) => {
    if (!open) return
    resetFromSettings()
    await nextTick()
    closeButton.value?.focus()
  }
)
</script>

<template>
  <Teleport to="body">
    <Transition name="cloud-drawer-fade">
      <div v-if="open" class="cloud-drawer-layer">
        <button class="cloud-backdrop" aria-label="关闭云端 API 配置" @click="emit('close')"></button>
        <aside
          ref="drawer"
          class="cloud-drawer"
          data-testid="cloud-api-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="cloud-drawer-title"
          @keydown="trapFocus"
        >
          <header class="cloud-header">
            <div><span>CLOUD / GENERATOR</span><h2 id="cloud-drawer-title">云端弹幕生成</h2></div>
            <button ref="closeButton" type="button" @click="emit('close')">关闭</button>
          </header>

          <div v-if="sessionActive" class="cloud-lock" role="status">
            会话运行期间配置已锁定。停止会话后才能保存。
          </div>
          <div v-if="settings.warning" class="cloud-warning" role="status">{{ settings.warning }}</div>
          <div v-if="error" class="cloud-error" role="alert">{{ error }}</div>
          <form class="cloud-form" @submit.prevent="saveOnly">
            <label class="enable-row">
              <span><b>启用云端生成</b><small>OCR 通过保守生成策略后才会调用</small></span>
              <input v-model="draft.enabled" type="checkbox" :disabled="sessionActive || deleteApiKey" />
            </label>

            <label><span>Base URL</span><input v-model.trim="draft.baseUrl" type="url" maxlength="2048" placeholder="https://api.openai.com/v1" :disabled="sessionActive" /></label>
            <label><span>API Key</span><input v-model="apiKey" type="password" maxlength="8192" autocomplete="off" :placeholder="settings.hasApiKey ? '留空以保留已保存密钥' : '请输入 API Key'" :disabled="sessionActive || deleteApiKey" /></label>
            <div class="key-row">
              <small>{{ settings.hasApiKey ? `已保存 · ${settings.secretStorage === 'encrypted' ? '系统加密' : '仅本次运行'}` : '尚未保存密钥' }}</small>
              <button type="button" :disabled="sessionActive || !settings.hasApiKey" :class="{ active: deleteApiKey }" @click="requestDeleteKey">
                {{ deleteApiKey ? '取消删除' : '删除密钥' }}
              </button>
            </div>
            <label><span>模型名</span><input v-model.trim="draft.model" maxlength="200" placeholder="例如 gpt-4.1-mini" :disabled="sessionActive" /></label>
            <label><span>系统提示词</span><textarea v-model="draft.systemPrompt" maxlength="8000" rows="10" :disabled="sessionActive"></textarea></label>
            <button class="prompt-reset" type="button" :disabled="sessionActive" @click="restorePrompt">恢复默认提示词</button>

            <div class="cloud-number-grid">
              <label><span>超时（秒）</span><input v-model.number="draft.timeoutMs" type="number" min="3000" max="15000" step="1000" :disabled="sessionActive" /><small>{{ (draft.timeoutMs / 1000).toFixed(0) }} 秒</small></label>
            </div>

            <section class="privacy-note">
              <strong>PRIVACY GATE</strong>
              <p>只发送用户确认的游戏名称和最多 300 字符的 OCR 文本；不发送截图、完整窗口标题或事件历史。调用失败时只记录原因，不生成本地模板弹幕。</p>
            </section>

            <footer>
              <button class="cloud-save" type="submit" :disabled="busy || sessionActive">{{ busy ? '保存中' : '保存配置' }}</button>
            </footer>
          </form>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.cloud-drawer-layer { position: fixed; inset: 0; z-index: 110; }
.cloud-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; min-height: 0; padding: 0; border: 0; border-radius: 0; background: transparent; -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); cursor: default; }
.cloud-backdrop:hover, .cloud-backdrop:focus-visible, .cloud-backdrop:active { background: transparent; }
.cloud-drawer { position: absolute; inset: 0 0 0 auto; width: min(380px, 100vw); overflow-y: auto; scrollbar-width: none; color: #e9efea; border-left: 1px solid #526058; background: #101512; box-shadow: -20px 0 55px rgba(0,0,0,.34); }
.cloud-drawer::-webkit-scrollbar { width: 0; height: 0; display: none; }
.cloud-header { min-height: 92px; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 22px 24px; border-bottom: 1px solid #354139; }
.cloud-header span { color: #a7e46b; font: 500 9px 'JetBrains Mono', monospace; letter-spacing: .14em; }
.cloud-header h2 { margin: 5px 0 0; font-size: 22px; font-weight: 500; letter-spacing: -.03em; }
.cloud-drawer button { min-height: 34px; padding: 0 11px; color: #e9efea; border: 1px solid #526058; border-radius: 6px; background: transparent; cursor: pointer; font-size: 11px; }
.cloud-drawer button:hover:not(:disabled) { background: #1d251f; }.cloud-drawer button:disabled { opacity: .42; cursor: not-allowed; }
.cloud-drawer button:focus-visible, .cloud-drawer input:focus-visible, .cloud-drawer textarea:focus-visible { outline: 2px solid #a7e46b; outline-offset: 2px; }
.cloud-lock, .cloud-warning, .cloud-error { margin: 16px 24px 0; padding: 11px 12px; border: 1px solid #526058; border-radius: 6px; font-size: 10px; line-height: 1.55; }
.cloud-lock, .cloud-warning { color: #e7b75f; border-color: color-mix(in srgb, #e7b75f 55%, #354139); }.cloud-error { color: #db6b63; border-color: color-mix(in srgb, #db6b63 55%, #354139); }
.cloud-form { display: grid; gap: 15px; padding: 20px 24px 24px; }
.cloud-form label { display: grid; gap: 7px; min-width: 0; }.cloud-form label > span, .enable-row > span { color: #c7d0c9; font-size: 11px; }
.cloud-form input:not([type='checkbox']), .cloud-form textarea { width: 100%; color: #e9efea; border: 1px solid #526058; border-radius: 6px; background: #171d19; font: 500 11px 'JetBrains Mono', monospace; }
.cloud-form input:not([type='checkbox']) { height: 38px; padding: 0 10px; }.cloud-form textarea { min-height: 180px; padding: 10px; resize: vertical; line-height: 1.6; font-family: 'IBM Plex Sans SC', 'Noto Sans SC', sans-serif; }
.enable-row { grid-template-columns: 1fr auto; align-items: center; padding-bottom: 15px; border-bottom: 1px solid #354139; }.enable-row span { display: grid; gap: 4px; }.enable-row b { font-size: 12px; font-weight: 500; }.enable-row small, .key-row small, .cloud-number-grid small { color: #87938b; font: 400 9px 'JetBrains Mono', monospace; }
.enable-row input { width: 34px; height: 18px; accent-color: #a7e46b; }
.key-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: -8px; }.key-row button { min-height: 28px; padding-inline: 8px; color: #db6b63; }.key-row button.active { color: #101512; background: #e7b75f; }
.prompt-reset { justify-self: start; margin-top: -8px; color: #e7b75f; }
.cloud-number-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }.cloud-number-grid label { position: relative; }.cloud-number-grid small { position: absolute; right: 9px; bottom: 12px; pointer-events: none; }.cloud-number-grid input { padding-right: 48px !important; }
.privacy-note { padding: 13px; border: 1px solid #354139; border-radius: 6px; background: #151b17; }.privacy-note strong { color: #a7e46b; font: 500 9px 'JetBrains Mono', monospace; letter-spacing: .1em; }.privacy-note p { margin: 8px 0 0; color: #87938b; font-size: 10px; line-height: 1.65; }
.cloud-form footer { display: grid; padding-top: 4px; }.cloud-save { width: 100%; color: #101512; border-color: #a7e46b; background: #a7e46b; font-weight: 600; }
.cloud-drawer-fade-enter-active, .cloud-drawer-fade-leave-active { transition: opacity 160ms ease; }.cloud-drawer-fade-enter-active .cloud-drawer, .cloud-drawer-fade-leave-active .cloud-drawer { transition: transform 180ms ease; }
.cloud-drawer-fade-enter-from, .cloud-drawer-fade-leave-to { opacity: 0; }.cloud-drawer-fade-enter-from .cloud-drawer, .cloud-drawer-fade-leave-to .cloud-drawer { transform: translateX(18px); }
@media (prefers-reduced-motion: reduce) { .cloud-drawer-fade-enter-active, .cloud-drawer-fade-leave-active, .cloud-drawer-fade-enter-active .cloud-drawer, .cloud-drawer-fade-leave-active .cloud-drawer { transition-duration: .01ms; } }
</style>
