import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/noto-sans-sc/chinese-simplified-400.css'
import '@fontsource/noto-sans-sc/chinese-simplified-600.css'
import '@fontsource/jetbrains-mono/500.css'
import './fixture.css'

const clock = document.querySelector<HTMLElement>('#fixture-clock')
const frame = document.querySelector<HTMLElement>('#fixture-frame')
let ticks = 0

function update(): void {
  ticks += 1
  if (clock) clock.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  if (frame) frame.textContent = String(ticks).padStart(4, '0')
}

update()
window.setInterval(update, 1000)
