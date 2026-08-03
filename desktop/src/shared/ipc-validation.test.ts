import { describe, expect, it } from 'vitest'
import {
  MAX_CLIPBOARD_TEXT_LENGTH,
  assertClipboardText,
  assertFrameUpload,
  assertSourceId
} from './ipc-validation'

const validFrame = {
  sessionId: 'b01d23c4-3335-4b1a-8bfa-671b0654a459',
  regionId: '03c6b867-c496-45ee-ad76-d11482dc03dc',
  frameId: '2e65e862-ae37-43e9-92e2-64ed213fa27a',
  capturedAt: '2026-08-02T04:00:00.000Z',
  width: 640,
  height: 360,
  bytes: new ArrayBuffer(4)
}

describe('IPC 参数校验', () => {
  it('接受有效捕获源与帧', () => {
    expect(() => assertSourceId('window:123:0')).not.toThrow()
    expect(() => assertFrameUpload(validFrame)).not.toThrow()
  })

  it('拒绝空捕获源 ID', () => {
    expect(() => assertSourceId('')).toThrow(/ID/)
  })

  it('拒绝非 UUID 帧标识', () => {
    expect(() => assertFrameUpload({ ...validFrame, frameId: 'frame-1' })).toThrow(/UUID/)
  })

  it('拒绝超过 1 MiB 的帧', () => {
    expect(() =>
      assertFrameUpload({ ...validFrame, bytes: new ArrayBuffer(1024 * 1024 + 1) })
    ).toThrow(/1 MiB/)
  })

  it('接受有效剪贴板文本', () => {
    expect(() => assertClipboardText('完整事件摘要')).not.toThrow()
  })

  it('拒绝空值、非字符串和超长剪贴板文本', () => {
    expect(() => assertClipboardText('   ')).toThrow(/1～8192/)
    expect(() => assertClipboardText(42)).toThrow(/1～8192/)
    expect(() => assertClipboardText('x'.repeat(MAX_CLIPBOARD_TEXT_LENGTH + 1))).toThrow(/1～8192/)
  })
})
