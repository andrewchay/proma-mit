import { expect, test, chromium } from '@playwright/test'
import { PlaywrightCdpBackend } from '../../apps/electron/src/main/lib/web-automation-backend.ts'

const CDP_PORT = 19333

test('given a user-owned Chrome CDP page when Web Bridge operates it then elementId, shadow DOM, iframe and screenshot remain available', async () => {
  const browser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${CDP_PORT}`] })
  try {
    const page = await browser.newPage()
    await page.setContent(`
      <button id="continue">Continue</button>
      <input aria-label="Search" />
      <iframe srcdoc="<button aria-label='Frame action'>Frame</button>"></iframe>
      <div id="shadow-host"></div>
      <script>
        const root = document.querySelector('#shadow-host').attachShadow({ mode: 'open' });
        root.innerHTML = '<button aria-label="Shadow action">Shadow</button>';
        document.querySelector('#continue').addEventListener('click', () => document.title = 'Clicked');
      </script>
    `)

    const cdp = await page.context().newCDPSession(page)
    const targetInfo = await cdp.send('Target.getTargetInfo') as { targetInfo: { targetId: string } }
    await cdp.detach()
    const backend = await PlaywrightCdpBackend.connect(CDP_PORT, targetInfo.targetInfo.targetId)
    try {
      const snapshot = await backend.snapshot()
      const continueButton = snapshot.accessibility.find((node) => node.name === 'Continue')
      const searchInput = snapshot.accessibility.find((node) => node.name === 'Search')

      expect(continueButton?.elementId).toBeTruthy()
      expect(searchInput?.elementId).toBeTruthy()
      expect(snapshot.accessibilityTree.some((node) => node.name === 'Shadow action')).toBe(true)
      expect(snapshot.accessibility.some((node) => node.name === 'Frame action' && node.frameId)).toBe(true)

      await backend.click({ elementId: continueButton?.elementId })
      await expect(page).toHaveTitle('Clicked')
      await backend.type({ elementId: searchInput?.elementId }, 'Proma', false)
      await expect(page.getByLabel('Search')).toHaveValue('Proma')
      expect((await backend.screenshot()).data.length).toBeGreaterThan(0)
    } finally {
      await backend.close()
    }

    // backend.close() 只能断开 CDP，不能关闭用户自己启动的 Chrome。
    await expect(page).toHaveTitle('Clicked')
  } finally {
    await browser.close()
  }
})
