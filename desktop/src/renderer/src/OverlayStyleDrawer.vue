<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { damuApi } from './api'
import {
  cloneDefaultOverlayStyle,
  effectiveDanmakuDuration,
  MAX_OVERLAY_SPEED,
  MIN_OVERLAY_SPEED,
  OVERLAY_SPEED_STEP,
  overlayStyleVariables,
  parseOverlayStyleSettings,
  type OverlayFontFamily,
  type OverlayFontWeight,
  type OverlayStyleSettings
} from '../../shared/overlay-style'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const drawer = ref<HTMLElement>()
const closeButton = ref<HTMLButtonElement>()
const draft = ref(cloneDefaultOverlayStyle())
const colorInput = ref(draft.value.textColor)
const initialized = ref(false)
const saveStatus = ref<'loading' | 'saved' | 'saving' | 'error'>('loading')
const saveError = ref('')
const previewStyle = computed<Record<string, string>>(() => ({
  ...overlayStyleVariables(draft.value),
  '--danmaku-preview-duration': `${effectiveDanmakuDuration(7000, draft.value.speedMultiplier)}ms`
}))
const opacityPercent = computed(() => Math.round(draft.value.backgroundOpacity * 100))
const speedLabel = computed(() => draft.value.speedMultiplier.toFixed(1))
let saveTimer: number | undefined
let revision = 0
let disposeStyle: (() => void) | undefined

const fontOptions: Array<{ value: OverlayFontFamily; label: string; detail: string }> = [
  { value: 'sans', label: '工业无衬线', detail: 'IBM Plex + 思源黑体' },
  { value: 'cjk', label: '中文优先', detail: '思源黑体' },
  { value: 'mono', label: '等宽技术体', detail: 'JetBrains Mono + 思源黑体' }
]
const colorPresets = ['#F4F8F5', '#A7E46B', '#E7B75F', '#DB6B63']

function updateDraft(patch: Partial<OverlayStyleSettings>): void {
  draft.value = { ...draft.value, ...patch }
  if (patch.textColor) colorInput.value = patch.textColor
  scheduleSave()
}

function scheduleSave(): void {
  if (!initialized.value) return
  revision += 1
  saveStatus.value = 'saving'
  saveError.value = ''
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void persist(revision), 150)
}

async function persist(targetRevision = revision): Promise<void> {
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  saveTimer = undefined
  saveStatus.value = 'saving'
  saveError.value = ''
  try {
    const saved = await damuApi.updateOverlayStyle(parseOverlayStyleSettings(draft.value))
    if (targetRevision === revision) {
      draft.value = { ...saved }
      colorInput.value = saved.textColor
      saveStatus.value = 'saved'
    }
  } catch (error) {
    if (targetRevision === revision) {
      saveStatus.value = 'error'
      saveError.value = error instanceof Error ? error.message : String(error)
    }
  }
}

function setFontFamily(event: Event): void {
  updateDraft({ fontFamily: (event.target as HTMLSelectElement).value as OverlayFontFamily })
}

function setFontSize(value: string): void {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return
  updateDraft({ fontSizePx: Math.min(48, Math.max(14, Math.round(parsed))) })
}

function setFontWeight(fontWeight: OverlayFontWeight): void {
  updateDraft({ fontWeight })
}

function setOpacity(value: string): void {
  updateDraft({ backgroundOpacity: Number(value) / 100 })
}

function setSpeed(value: string): void {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return
  const rounded = Math.round(parsed / OVERLAY_SPEED_STEP) * OVERLAY_SPEED_STEP
  updateDraft({
    speedMultiplier: Math.min(MAX_OVERLAY_SPEED, Math.max(MIN_OVERLAY_SPEED, rounded))
  })
}

function setColor(value: string): void {
  updateDraft({ textColor: value.toUpperCase() })
}

function inputHex(value: string): void {
  colorInput.value = value.toUpperCase()
  if (/^#[0-9A-F]{6}$/.test(colorInput.value)) setColor(colorInput.value)
}

function resetDefaults(): void {
  draft.value = cloneDefaultOverlayStyle()
  colorInput.value = draft.value.textColor
  scheduleSave()
}

function trapFocus(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    emit('close')
    return
  }
  if (event.key !== 'Tab' || !drawer.value) return
  const elements = [...drawer.value.querySelectorAll<HTMLElement>(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'
  )]
  if (elements.length === 0) return
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

watch(
  () => props.open,
  async (open) => {
    document.documentElement.classList.toggle('style-drawer-open', open)
    if (open) {
      await nextTick()
      closeButton.value?.focus()
    }
  }
)

onMounted(async () => {
  document.documentElement.classList.toggle('style-drawer-open', props.open)
  disposeStyle = damuApi.onOverlayStyle((settings) => {
    const parsed = parseOverlayStyleSettings(settings)
    if (saveStatus.value !== 'saving') {
      draft.value = parsed
      colorInput.value = parsed.textColor
    }
  })
  try {
    draft.value = parseOverlayStyleSettings(await damuApi.getOverlayStyle())
    colorInput.value = draft.value.textColor
    saveStatus.value = 'saved'
  } catch (error) {
    saveStatus.value = 'error'
    saveError.value = error instanceof Error ? error.message : String(error)
  } finally {
    initialized.value = true
  }
})

onUnmounted(() => {
  document.documentElement.classList.remove('style-drawer-open')
  if (saveTimer !== undefined) window.clearTimeout(saveTimer)
  disposeStyle?.()
})
</script>

<template>
  <Teleport to="body">
    <Transition name="drawer-fade">
      <div v-if="open" class="style-drawer-layer">
        <button class="drawer-backdrop" aria-label="关闭弹幕样式设置" @click="emit('close')"></button>
        <aside
          ref="drawer"
          class="style-drawer"
          role="dialog"
          aria-modal="true"
          aria-labelledby="style-drawer-title"
          @keydown="trapFocus"
        >
          <header class="drawer-header">
            <div>
              <span class="drawer-index">OVERLAY / TYPE</span>
              <h2 id="style-drawer-title">弹幕样式</h2>
            </div>
            <button ref="closeButton" class="drawer-close" type="button" @click="emit('close')">关闭</button>
          </header>

          <section class="style-preview" :style="previewStyle" aria-label="弹幕样式预览">
            <span class="preview-grid" aria-hidden="true"></span>
            <div
              :key="speedLabel"
              class="preview-message"
              data-testid="style-preview-message"
              :data-speed-multiplier="speedLabel"
            ><i></i>游戏事件已识别 · 弹幕样式预览</div>
          </section>

          <div class="save-readout" :class="saveStatus" aria-live="polite">
            <i></i>
            <span v-if="saveStatus === 'loading'">正在读取本地设置</span>
            <span v-else-if="saveStatus === 'saving'">正在保存并同步覆盖层</span>
            <span v-else-if="saveStatus === 'error'">保存失败</span>
            <span v-else>本地设置已保存</span>
          </div>
          <div v-if="saveError" class="style-save-error" role="alert">
            <p>{{ saveError }}</p>
            <button type="button" @click="persist()">重试保存</button>
          </div>

          <form class="style-form" @submit.prevent>
            <label class="style-field">
              <span><b>字体组合</b><small>仅使用应用内置字体</small></span>
              <select :value="draft.fontFamily" @change="setFontFamily">
                <option v-for="font in fontOptions" :key="font.value" :value="font.value">
                  {{ font.label }} · {{ font.detail }}
                </option>
              </select>
            </label>

            <fieldset class="style-field">
              <legend><b>字号</b><small>14–48 PX</small></legend>
              <div class="range-row">
                <input
                  type="range"
                  min="14"
                  max="48"
                  step="1"
                  :value="draft.fontSizePx"
                  aria-label="弹幕字号"
                  @input="setFontSize(($event.target as HTMLInputElement).value)"
                />
                <input
                  class="number-input"
                  type="number"
                  min="14"
                  max="48"
                  :value="draft.fontSizePx"
                  aria-label="弹幕字号数值"
                  @change="setFontSize(($event.target as HTMLInputElement).value)"
                />
              </div>
            </fieldset>

            <fieldset class="style-field">
              <legend><b>字重</b><small>正文强调程度</small></legend>
              <div class="weight-switch" role="radiogroup" aria-label="弹幕字重">
                <button
                  v-for="weight in ([400, 500, 600] as const)"
                  :key="weight"
                  type="button"
                  role="radio"
                  :aria-checked="draft.fontWeight === weight"
                  :class="{ active: draft.fontWeight === weight }"
                  @click="setFontWeight(weight)"
                >
                  {{ weight }}
                </button>
              </div>
            </fieldset>

            <fieldset class="style-field color-field">
              <legend><b>文字颜色</b><small>正文统一，事件标记保留等级色</small></legend>
              <div class="color-presets" aria-label="预设文字颜色">
                <button
                  v-for="color in colorPresets"
                  :key="color"
                  type="button"
                  :class="{ active: draft.textColor === color }"
                  :style="{ '--swatch': color }"
                  :aria-label="`使用颜色 ${color}`"
                  @click="setColor(color)"
                ></button>
              </div>
              <div class="color-input-row">
                <input
                  class="native-color"
                  type="color"
                  :value="draft.textColor"
                  aria-label="选择文字颜色"
                  @input="setColor(($event.target as HTMLInputElement).value)"
                />
                <input
                  class="hex-input"
                  type="text"
                  maxlength="7"
                  :value="colorInput"
                  :aria-invalid="!/^#[0-9A-F]{6}$/.test(colorInput)"
                  aria-label="文字颜色 HEX"
                  @input="inputHex(($event.target as HTMLInputElement).value)"
                />
              </div>
              <small v-if="!/^#[0-9A-F]{6}$/.test(colorInput)" class="field-error">请输入 #RRGGBB</small>
            </fieldset>

            <fieldset class="style-field">
              <legend><b>背景不透明度</b><small>{{ opacityPercent }}%</small></legend>
              <div class="range-row opacity-row">
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  :value="opacityPercent"
                  aria-label="弹幕背景不透明度"
                  @input="setOpacity(($event.target as HTMLInputElement).value)"
                />
                <output>{{ opacityPercent }}%</output>
              </div>
            </fieldset>

            <fieldset class="style-field">
              <legend><b>弹幕速度</b><small>新弹幕 · {{ speedLabel }}×</small></legend>
              <div class="range-row speed-row">
                <input
                  type="range"
                  :min="MIN_OVERLAY_SPEED"
                  :max="MAX_OVERLAY_SPEED"
                  :step="OVERLAY_SPEED_STEP"
                  :value="draft.speedMultiplier"
                  aria-label="弹幕速度倍率"
                  data-testid="overlay-speed-input"
                  @input="setSpeed(($event.target as HTMLInputElement).value)"
                />
                <output>{{ speedLabel }}×</output>
                <div class="speed-scale" aria-hidden="true">
                  <span>0.5× 慢速</span>
                  <span>1.0× 标准</span>
                  <span>2.0× 快速</span>
                </div>
              </div>
            </fieldset>
          </form>

          <footer class="drawer-footer">
            <p>设置对所有窗口生效，并在应用重启后保留。</p>
            <button type="button" class="reset-button" @click="resetDefaults">恢复默认</button>
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
:global(html.style-drawer-open), :global(html.style-drawer-open body) { overflow: hidden; }
.style-drawer-layer { position: fixed; inset: 0; z-index: 100; }
.drawer-backdrop { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: rgba(5, 8, 6, .64); backdrop-filter: blur(2px); cursor: default; }
.style-drawer { position: absolute; inset: 0 0 0 auto; width: min(380px, 100vw); display: flex; flex-direction: column; overflow-y: auto; scrollbar-width: none; -ms-overflow-style: none; color: #e9efea; border-left: 1px solid #526058; background: #101512; box-shadow: -20px 0 55px rgba(0, 0, 0, .34); }
.style-drawer::-webkit-scrollbar { width: 0; height: 0; display: none; }
.drawer-header { min-height: 92px; display: flex; align-items: center; justify-content: space-between; gap: 18px; padding: 22px 24px; border-bottom: 1px solid #354139; }
.drawer-header h2 { margin: 5px 0 0; font-size: 22px; font-weight: 500; letter-spacing: -.03em; }
.drawer-index { color: #a7e46b; font: 500 9px 'JetBrains Mono', monospace; letter-spacing: .14em; }
.drawer-close, .reset-button { min-height: 34px; padding: 0 11px; color: #e9efea; border: 1px solid #526058; border-radius: 6px; background: transparent; cursor: pointer; font-size: 11px; }
.drawer-close:hover, .reset-button:hover { background: #1d251f; }
.drawer-close:focus-visible, .reset-button:focus-visible, .style-form input:focus-visible, .style-form select:focus-visible, .style-form button:focus-visible { outline: 2px solid #a7e46b; outline-offset: 2px; }
.style-preview { position: relative; flex: 0 0 130px; margin: 20px 24px 12px; overflow: hidden; border: 1px solid #354139; border-radius: 6px; background: #172019; font-family: var(--danmaku-font-family); }
.preview-grid { position: absolute; inset: 0; opacity: .18; background-image: linear-gradient(#526058 1px, transparent 1px), linear-gradient(90deg, #526058 1px, transparent 1px); background-size: 24px 24px; }
.preview-message { --danmaku-tone: #a7e46b; position: absolute; top: 44px; left: 100%; display: flex; align-items: center; gap: 8px; width: max-content; max-width: 92%; padding: 9px 12px 9px 9px; overflow: hidden; color: var(--danmaku-text-color); border: 1px solid color-mix(in srgb, var(--danmaku-tone) 46%, rgba(233, 239, 234, .56)); border-radius: 6px; background: var(--danmaku-background); font-family: var(--danmaku-font-family); font-size: var(--danmaku-font-size); font-weight: var(--danmaku-font-weight); line-height: 1.2; white-space: nowrap; text-overflow: ellipsis; text-shadow: 0 1px 4px rgba(0, 0, 0, .85); animation: preview-travel var(--danmaku-preview-duration, 7000ms) linear infinite; }
.preview-message i { width: 4px; height: 18px; flex: 0 0 auto; border-radius: 1px; background: var(--danmaku-tone); }
@keyframes preview-travel { from { transform: translateX(0); } to { transform: translateX(calc(-100% - 404px)); } }
.save-readout { min-height: 30px; display: flex; align-items: center; gap: 8px; margin: 0 24px; color: #87938b; font: 500 9px 'JetBrains Mono', monospace; letter-spacing: .05em; }
.save-readout i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.save-readout.saved { color: #a7e46b; }.save-readout.saving, .save-readout.loading { color: #e7b75f; }.save-readout.error { color: #db6b63; }
.style-save-error { margin: 0 24px 10px; padding: 10px 12px; border: 1px solid color-mix(in srgb, #db6b63 55%, #354139); border-radius: 6px; background: color-mix(in srgb, #db6b63 8%, transparent); }
.style-save-error p { margin: 0 0 8px; color: #e9efea; font-size: 11px; line-height: 1.5; }.style-save-error button { padding: 0; color: #db6b63; border: 0; background: transparent; cursor: pointer; font-size: 11px; }
.style-form { display: grid; padding: 4px 24px 22px; }
.style-field { min-width: 0; margin: 0; padding: 16px 0; border: 0; border-top: 1px solid #354139; }
label.style-field { display: grid; gap: 10px; }
.style-field > span, .style-field legend { width: 100%; display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 0; }
.style-field b { font-size: 12px; font-weight: 500; }.style-field small { color: #87938b; font: 400 9px 'JetBrains Mono', monospace; }
.style-field select, .number-input, .hex-input { height: 38px; color: #e9efea; border: 1px solid #526058; border-radius: 6px; background: #171d19; }
.style-field select { width: 100%; padding: 0 10px; font-size: 11px; }
.range-row { display: grid; grid-template-columns: minmax(0, 1fr) 64px; gap: 12px; align-items: center; margin-top: 12px; }
input[type='range'] { width: 100%; accent-color: #a7e46b; }
.number-input, .hex-input { width: 100%; padding: 0 9px; font: 500 11px 'JetBrains Mono', monospace; }
.weight-switch { display: grid; grid-template-columns: repeat(3, 1fr); margin-top: 12px; border: 1px solid #526058; border-radius: 6px; overflow: hidden; }
.weight-switch button { min-height: 36px; color: #87938b; border: 0; border-right: 1px solid #526058; background: #171d19; cursor: pointer; font: 500 10px 'JetBrains Mono', monospace; }.weight-switch button:last-child { border-right: 0; }.weight-switch button.active { color: #101512; background: #a7e46b; }
.color-presets { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin-top: 12px; }
.color-presets button { position: relative; height: 34px; border: 1px solid #526058; border-radius: 6px; background: #171d19; cursor: pointer; }.color-presets button::after { content: ''; position: absolute; inset: 8px; border-radius: 2px; background: var(--swatch); }.color-presets button.active { border-color: #a7e46b; box-shadow: inset 0 0 0 1px #a7e46b; }
.color-input-row { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 8px; margin-top: 8px; }
.native-color { width: 44px; height: 38px; padding: 4px; border: 1px solid #526058; border-radius: 6px; background: #171d19; cursor: pointer; }
.field-error { display: block; margin-top: 7px; color: #db6b63 !important; }
.opacity-row output, .speed-row output { color: #e9efea; text-align: right; font: 500 11px 'JetBrains Mono', monospace; }
.speed-row { grid-template-areas: 'slider output' 'scale empty'; row-gap: 7px; }
.speed-row > input { grid-area: slider; margin: 0; }.speed-row > output { grid-area: output; }.speed-scale { grid-area: scale; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); color: #87938b; font: 400 9px 'JetBrains Mono', monospace; line-height: 1.5; }
.speed-scale span:first-child { text-align: left; }.speed-scale span:nth-child(2) { text-align: center; }.speed-scale span:last-child { text-align: right; }
.drawer-footer { margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 18px 24px 22px; border-top: 1px solid #354139; background: #0d110f; }
.drawer-footer p { max-width: 190px; margin: 0; color: #87938b; font-size: 10px; line-height: 1.5; text-wrap: pretty; }
.reset-button { color: #e7b75f; white-space: nowrap; }
.drawer-fade-enter-active, .drawer-fade-leave-active { transition: opacity 160ms ease; }.drawer-fade-enter-active .style-drawer, .drawer-fade-leave-active .style-drawer { transition: transform 180ms ease; }
.drawer-fade-enter-from, .drawer-fade-leave-to { opacity: 0; }.drawer-fade-enter-from .style-drawer, .drawer-fade-leave-to .style-drawer { transform: translateX(18px); }
@media (prefers-reduced-motion: reduce) { .preview-message { left: 50%; transform: translateX(-50%); animation: preview-reduced 5.2s ease infinite; } @keyframes preview-reduced { 0%, 85% { opacity: 1; } 100% { opacity: 0; } } .drawer-fade-enter-active, .drawer-fade-leave-active, .drawer-fade-enter-active .style-drawer, .drawer-fade-leave-active .style-drawer { transition-duration: .01ms; } }
</style>
