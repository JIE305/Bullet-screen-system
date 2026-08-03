import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_OVERLAY_STYLE } from '../shared/overlay-style'
import { OverlayStyleStore } from './overlay-style-store'

const temporaryDirectories: string[] = []

async function makeStore(warn = vi.fn()): Promise<{ store: OverlayStyleStore; path: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'damu-overlay-style-'))
  temporaryDirectories.push(directory)
  const path = join(directory, 'overlay-style.json')
  return { store: new OverlayStyleStore(path, warn), path }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('弹幕样式持久化', () => {
  it('首次启动使用默认值，保存后可以重新加载', async () => {
    const { store, path } = await makeStore()
    expect(await store.load()).toEqual(DEFAULT_OVERLAY_STYLE)
    const expected = { ...DEFAULT_OVERLAY_STYLE, fontSizePx: 31, textColor: '#A7E46B' }

    await store.save(expected)

    expect(await new OverlayStyleStore(path).load()).toEqual(expected)
  })

  it('损坏文件回退默认值并报告警告', async () => {
    const warn = vi.fn()
    const { store, path } = await makeStore(warn)
    await writeFile(path, '{broken', 'utf8')

    expect(await store.load()).toEqual(DEFAULT_OVERLAY_STYLE)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('连续保存按提交顺序串行化并保留最终值', async () => {
    const { store, path } = await makeStore()

    await Promise.all([
      store.save({ ...DEFAULT_OVERLAY_STYLE, fontSizePx: 18 }),
      store.save({ ...DEFAULT_OVERLAY_STYLE, fontSizePx: 28 }),
      store.save({ ...DEFAULT_OVERLAY_STYLE, fontSizePx: 38 })
    ])

    expect(JSON.parse(await readFile(path, 'utf8'))).toMatchObject({ fontSizePx: 38 })
  })
})
