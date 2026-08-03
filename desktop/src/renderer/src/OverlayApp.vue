<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { damuApi } from './api'
import {
  OverlayMessageQueue,
  type OverlayMessage,
  type OverlayTone
} from '../../shared/overlay-queue'
import {
  cloneDefaultOverlayStyle,
  overlayStyleVariables,
  parseOverlayStyleSettings
} from '../../shared/overlay-style'

const messages = ref<OverlayMessage[]>([])
const settings = ref(cloneDefaultOverlayStyle())
const styleReady = ref(false)
const stageStyle = computed(() => overlayStyleVariables(settings.value))
const queue = new OverlayMessageQueue(
  (items) => {
    messages.value = items
  },
  {
    setTimeout: (callback, delay) => window.setTimeout(callback, delay),
    clearTimeout: (handle) => window.clearTimeout(handle as number)
  }
)
let disposeEvents: (() => void) | undefined
let disposeReset: (() => void) | undefined
let disposeStyle: (() => void) | undefined

function eventTone(value: unknown): OverlayTone {
  if (typeof value !== 'object' || value === null) return 'signal'
  const tone = String((value as Record<string, unknown>).tone ?? 'signal')
  return tone === 'warning' || tone === 'danger' ? tone : 'signal'
}

onMounted(async () => {
  disposeEvents = damuApi.onEvent((event) => {
    if (event.type === 'session.status' && event.payload.status === 'stopped') {
      queue.clear()
      return
    }
    if (event.type !== 'danmaku.created') return
    const duration = Number(event.payload.duration_ms ?? 7200)
    queue.add({
      id: String(event.payload.message_id ?? event.event_id),
      text: String(event.payload.text ?? ''),
      duration,
      tone: eventTone(event.payload.style)
    })
  })
  disposeReset = damuApi.onOverlayReset(() => queue.clear())
  disposeStyle = damuApi.onOverlayStyle((next) => {
    settings.value = parseOverlayStyleSettings(next)
  })
  try {
    settings.value = parseOverlayStyleSettings(await damuApi.getOverlayStyle())
  } catch (error) {
    console.error('Overlay style load failed', error)
  }
  styleReady.value = true
  await nextTick()
  damuApi.notifyOverlayStyleReady()
})

onUnmounted(() => {
  disposeEvents?.()
  disposeReset?.()
  disposeStyle?.()
  queue.dispose()
})
</script>

<template>
  <main v-if="styleReady" class="overlay-stage" :style="stageStyle" aria-live="polite">
    <div
      v-for="message in messages"
      :key="message.id"
      class="danmaku-message"
      :class="message.tone"
      :style="{ top: `${36 + message.lane * 54}px`, animationDuration: `${message.duration}ms` }"
    >
      <span class="signal-mark" aria-hidden="true"></span>
      {{ message.text }}
    </div>
  </main>
</template>

<style>
html, body, #app { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent !important; }
.overlay-stage { position: relative; width: 100%; height: 100%; overflow: hidden; pointer-events: none; font-family: var(--danmaku-font-family); }
.danmaku-message { --danmaku-tone: #a7e46b; position: absolute; left: 100%; max-width: min(680px, 70vw); display: flex; align-items: center; gap: 10px; padding: 10px 15px 10px 11px; border: 1px solid color-mix(in srgb, var(--danmaku-tone) 46%, rgba(233, 239, 234, .56)); border-radius: 6px; color: var(--danmaku-text-color); background: var(--danmaku-background); box-shadow: 0 8px 30px rgba(0, 0, 0, .28); backdrop-filter: blur(7px); font-family: var(--danmaku-font-family); font-size: var(--danmaku-font-size); font-weight: var(--danmaku-font-weight); line-height: 1.2; white-space: nowrap; text-shadow: 0 1px 4px rgba(0, 0, 0, .85); animation: travel linear forwards; will-change: transform; }
.danmaku-message.warning { --danmaku-tone: #e7b75f; }
.danmaku-message.danger { --danmaku-tone: #db6b63; }
.signal-mark { width: 4px; height: 20px; flex: 0 0 auto; border-radius: 1px; background: var(--danmaku-tone); }
@keyframes travel { from { transform: translateX(0); } to { transform: translateX(calc(-100vw - 120%)); } }
@media (prefers-reduced-motion: reduce) {
  .danmaku-message { left: 50%; transform: translateX(-50%); animation: reduced-message 5.2s ease forwards; }
  @keyframes reduced-message { 0%, 85% { opacity: 1; } 100% { opacity: 0; } }
}
</style>
