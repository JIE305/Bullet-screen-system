import type { FrameUpload } from './contracts'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_IMAGE_BYTES = 1024 * 1024
export const MAX_CLIPBOARD_TEXT_LENGTH = 8192

export function assertSourceId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new TypeError('捕获源 ID 无效')
  }
}

export function assertClipboardText(value: unknown): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value.length > MAX_CLIPBOARD_TEXT_LENGTH
  ) {
    throw new TypeError('剪贴板文本必须为 1～8192 个字符')
  }
}

export function assertFrameUpload(value: unknown): asserts value is FrameUpload {
  if (!value || typeof value !== 'object') throw new TypeError('帧参数无效')
  const frame = value as Partial<FrameUpload>
  if (
    !UUID_PATTERN.test(frame.sessionId ?? '') ||
    !UUID_PATTERN.test(frame.regionId ?? '') ||
    !UUID_PATTERN.test(frame.frameId ?? '')
  ) {
    throw new TypeError('帧标识必须是 UUID')
  }
  if (typeof frame.capturedAt !== 'string' || !Number.isFinite(Date.parse(frame.capturedAt))) {
    throw new TypeError('采集时间无效')
  }
  if (
    !Number.isInteger(frame.width) ||
    !Number.isInteger(frame.height) ||
    frame.width! < 1 ||
    frame.height! < 1 ||
    frame.width! > 4096 ||
    frame.height! > 4096
  ) {
    throw new TypeError('帧尺寸无效')
  }
  if (!(frame.bytes instanceof ArrayBuffer) || frame.bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new TypeError('JPEG 数据无效或超过 1 MiB')
  }
}
