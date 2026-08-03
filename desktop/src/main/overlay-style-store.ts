import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import {
  cloneDefaultOverlayStyle,
  parseOverlayStyleSettings,
  type OverlayStyleSettings
} from '../shared/overlay-style'

export class OverlayStyleStore {
  private writeChain: Promise<void> = Promise.resolve()

  constructor(
    readonly filePath: string,
    private readonly warn: (message: string) => void = console.warn
  ) {}

  async load(): Promise<OverlayStyleSettings> {
    try {
      const content = await readFile(this.filePath, 'utf8')
      return parseOverlayStyleSettings(JSON.parse(content) as unknown)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.warn(`弹幕样式文件无效，已恢复默认值：${error instanceof Error ? error.message : String(error)}`)
      }
      return cloneDefaultOverlayStyle()
    }
  }

  save(value: unknown): Promise<OverlayStyleSettings> {
    const settings = parseOverlayStyleSettings(value)
    const persist = async (): Promise<void> => {
      await mkdir(dirname(this.filePath), { recursive: true })
      const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
      await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
      await rename(temporaryPath, this.filePath)
    }
    this.writeChain = this.writeChain.catch(() => undefined).then(persist)
    return this.writeChain.then(() => ({ ...settings }))
  }
}
