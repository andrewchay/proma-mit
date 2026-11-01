/** 在真实打包渲染器中验收 OpenDesign 下载和 Owner 安装，不访问网络或用户工作区。 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import type { AgentWorkspace, OwnerRuntimeBinding } from '@gravitas/shared'
import { setMainWindow } from '../main-window'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

async function waitRenderer(window: BrowserWindow, script: string, description: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = ''
  while (Date.now() < deadline) {
    try {
      if (await window.webContents.executeJavaScript(`Boolean(${script})`, true)) return
    } catch (error) { lastError = String(error) }
    await sleep(100)
  }
  const body = await window.webContents.executeJavaScript('document.body.innerText.slice(-1400)', true).catch(() => '')
  throw new Error(`打包渲染器验收超时：${description}${lastError ? `（${lastError}）` : ''}；当前界面：${JSON.stringify(body)}`)
}

async function clickProjectModule(window: BrowserWindow): Promise<void> {
  const clicked = await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '项目管理')
    if (!button) return false
    button.click()
    return true
  })()`, true)
  assert(clicked, '找不到项目管理入口')
}

export async function runPackageDesignSmoke(root: string): Promise<Record<string, unknown>> {
  const { createOwnerDesignSystemInstaller, readBundledReference, readInstalledOwnerDesignSystem } = await import('./opendesign-install-service')
  const ownerWorkspace: AgentWorkspace = { id: 'package-opendesign-workspace', name: 'Package OpenDesign Smoke', slug: 'package-opendesign-smoke', createdAt: 1, updatedAt: 1 }
  const ownerBinding: OwnerRuntimeBinding = {
    schemaVersion: 1, projectId: 'package-opendesign-project', revision: 1,
    ownerRole: 'project_owner', ownerName: 'Package Smoke Owner', carrierId: 'package-smoke-owner',
    workspaceId: ownerWorkspace.id, channelId: 'package-smoke-channel', modelId: 'package-smoke-model',
    runtime: 'ai-sdk', carrierFingerprint: 'a'.repeat(64), actor: 'local-user', savedAt: 1, changeReason: 'test',
  }
  const ownerRoot = join(root, ownerWorkspace.slug)
  const ownerFiles = join(ownerRoot, 'workspace-files')
  mkdirSync(ownerFiles, { recursive: true })
  const installer = createOwnerDesignSystemInstaller({
    getBinding: projectId => projectId === ownerBinding.projectId ? ownerBinding : null,
    getWorkspace: workspaceId => workspaceId === ownerWorkspace.id ? ownerWorkspace : undefined,
    getWorkspacePath: () => ownerRoot,
    getWorkspaceFilesDir: () => ownerFiles,
    loadReference: brandId => readBundledReference(brandId, process.resourcesPath),
    now: () => 1,
  })
  const installPreview = installer.preview(ownerBinding.projectId, 'stripe')
  assert(installPreview.canInstall, '隔离 Owner 工作区应可安装随包的 OpenDesign 参考')
  const installed = installer.install({
    projectId: ownerBinding.projectId,
    brandId: 'stripe',
    expectedOwnerBindingRevision: installPreview.ownerBindingRevision,
    expectedWorkspaceId: installPreview.workspaceId,
    expectedReferenceRevision: installPreview.referenceRevision,
    confirmed: true,
  })
  const installedReference = installer.readInstalled(ownerWorkspace.slug)
  const bundledReference = readBundledReference('stripe', process.resourcesPath)
  assert(installedReference, '打包 OpenDesign 参考未能从隔离工作区完整读回')
  assert.equal(installedReference.design, bundledReference.reference.design, '安装后的设计说明与实际打包资源不一致')
  assert.equal(installedReference.tokens, bundledReference.reference.tokens, '安装后的令牌与实际打包资源不一致')
  assert.equal(installedReference.referenceRevision, bundledReference.revision)
  assert.equal(installer.preview(ownerBinding.projectId, 'stripe').canInstall, false, '重复安装预览必须报告冲突并避免覆盖')

  const { initProjectDb, closeProjectDb, createProject } = await import('./project-sqlite-store')
  const { saveProjectOwnerGoalDraft } = await import('./project-owner-goal-service')
  const { createAgentWorkspace } = await import('./agent-workspace-manager')
  const { bindWorkspaceToProject } = await import('./project-workspace-bindings')
  const { createAgentEmployee } = await import('./agent-employee-service')
  const { createChannel } = await import('./channel-manager')
  const { saveOwnerRuntimeBinding } = await import('./project-owner-runtime-binding')
  const { registerIpcHandlers } = await import('../ipc')
  await initProjectDb()
  const project = createProject({ title: 'Package OpenDesign Smoke', description: '临时本地验收项目' })
  const smokeOwnerWorkspace = createAgentWorkspace('Package OpenDesign Smoke Owner')
  bindWorkspaceToProject(project.id, smokeOwnerWorkspace.id)
  const smokeChannel = createChannel({
    name: 'Package OpenDesign Smoke Channel', provider: 'openai', baseUrl: 'https://example.invalid',
    apiKey: 'package-smoke-not-used', enabled: true,
    models: [{ id: 'package-smoke-model', name: 'Package Smoke Model', enabled: true }],
  })
  const ownerCarrier = createAgentEmployee({
    name: 'Package OpenDesign Smoke Carrier', role: '项目 Owner 验收载体', description: '不调用模型的打包界面验收夹具',
    runtime: 'ai-sdk', channelId: smokeChannel.id, modelId: 'package-smoke-model',
    workspaceIds: [smokeOwnerWorkspace.id], executionProfile: 'controlled', permissionMode: 'safe',
  })
  saveOwnerRuntimeBinding(project.id, 0, {
    ownerName: 'Package Smoke Owner', carrierId: ownerCarrier.id,
    workspaceId: smokeOwnerWorkspace.id, changeReason: '隔离打包界面验收',
  })
  saveProjectOwnerGoalDraft(project.id, 0, {
    objective: '只验证本地设计参考下载，不调用模型', constraints: [], acceptanceCriteria: ['下载内容正确且原文件不变'],
  })
  await registerIpcHandlers()

  const downloadDir = join(root, 'opendesign-downloads')
  const userWorkspace = join(root, 'opendesign-user-workspace')
  mkdirSync(downloadDir, { recursive: true })
  mkdirSync(userWorkspace, { recursive: true })
  writeFileSync(join(userWorkspace, 'DESIGN.md'), 'USER_DESIGN_CANARY')
  writeFileSync(join(userWorkspace, 'tokens.css'), 'USER_TOKENS_CANARY')

  const window = new BrowserWindow({
    show: false, width: 1280, height: 900,
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  setMainWindow(window)
  const downloads: Array<{ path: string; state: string }> = []
  window.webContents.session.on('will-download', (_event, item) => {
    const path = join(downloadDir, item.getFilename())
    item.setSavePath(path)
    const record = { path, state: 'started' }
    downloads.push(record)
    item.once('done', (_doneEvent, state) => { record.state = state })
  })
  try {
    await window.loadFile(join(__dirname, 'renderer', 'index.html'))
    await waitRenderer(window, `document.body.innerText.includes('开始使用')`, '首次启动欢迎页')
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '开始使用').click()`, true)
    await waitRenderer(window, `document.body.innerText.includes('稍后设置')`, '订阅引导页')
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '稍后设置').click()`, true)
    await waitRenderer(window, `[...document.querySelectorAll('button')].some(item => item.textContent?.trim() === '智能体')`, '模式导航加载')
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item => item.textContent?.trim() === '智能体').click()`, true)
    await waitRenderer(window, `[...document.querySelectorAll('button')].some(item => item.textContent?.trim() === '项目管理')`, '应用导航加载')
    await clickProjectModule(window)
    await waitRenderer(window, `document.body.innerText.includes(${JSON.stringify(project.title)})`, '验收项目出现')
    const ownerConversationSelector = `[aria-label=${JSON.stringify(`与 ${project.title} 的 Owner 对话`)}]`
    await waitRenderer(window, `document.querySelector(${JSON.stringify(ownerConversationSelector)}) instanceof HTMLElement`, 'Owner 对话入口出现')
    const opened = await window.webContents.executeJavaScript(`(() => {
      const button = document.querySelector(${JSON.stringify(ownerConversationSelector)})
      if (!(button instanceof HTMLElement)) return false
      button.click()
      return true
    })()`, true)
    assert(opened, '打不开验收项目的 Owner 对话')
    await waitRenderer(window, `document.querySelector('details[aria-label="设计任务草稿"]')`, '设计任务草稿出现')
    await window.webContents.executeJavaScript(`document.querySelector('details[aria-label="设计任务草稿"] > summary').click()`, true)
    await waitRenderer(window, `document.querySelector('details[aria-label="设计任务草稿"] select')`, '设计参考选择器出现')
    await window.webContents.executeJavaScript(`(() => {
      const labels = [...document.querySelectorAll('label')]
      const select = labels.find(item => item.textContent?.includes('设计系统参考（可选）'))?.querySelector('select')
      if (!(select instanceof HTMLSelectElement)) throw new Error('设计参考选择器缺失')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'stripe')
      select.dispatchEvent(new Event('change', { bubbles: true }))
      const reference = document.querySelector('details[aria-label="设计系统参考内容"] > summary')
      if (!(reference instanceof HTMLElement)) throw new Error('设计参考内容入口缺失')
      reference.click()
    })()`, true)
    await waitRenderer(window, `[...document.querySelectorAll('button')].some(item => item.textContent === '下载设计说明' && !item.disabled)`, '设计说明下载按钮')

    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item => item.textContent === '安装到 Owner 工作区').click()`, true)
    await waitRenderer(window, `document.querySelector('[aria-label="确认 OpenDesign 安装"]') || Boolean(document.querySelector('details[aria-label="设计任务草稿"] [role="status"]')?.textContent?.trim())`, 'Owner 安装预览结果')
    const hasInstallPreview = await window.webContents.executeJavaScript(`document.querySelector('[aria-label="确认 OpenDesign 安装"]') instanceof HTMLElement`, true)
    const installPreviewStatus = await window.webContents.executeJavaScript(`document.querySelector('details[aria-label="设计任务草稿"] [role="status"]')?.textContent?.trim() ?? ''`, true)
    assert(hasInstallPreview, `Owner 安装预览失败：${installPreviewStatus || '没有返回预览结果'}`)
    assert((await window.webContents.executeJavaScript(`document.querySelector('[aria-label="确认 OpenDesign 安装"]').innerText`, true)).includes(smokeOwnerWorkspace.name), '确认卡片未显示实际绑定的 Owner 工作区')
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item => item.textContent === '确认安装').click()`, true)
    await waitRenderer(window, `document.querySelector('[role="status"]')?.textContent.includes('已安装到 Owner 工作区')`, 'Owner 安装成功状态')
    const uiInstalledReference = readInstalledOwnerDesignSystem(smokeOwnerWorkspace.slug)
    assert(uiInstalledReference, 'Owner 界面确认后未能读回已安装参考')
    const uiBundledReference = readBundledReference('stripe', process.resourcesPath)
    assert.equal(uiInstalledReference.design, uiBundledReference.reference.design, 'Owner 界面安装的设计说明与打包资源不一致')
    assert.equal(uiInstalledReference.tokens, uiBundledReference.reference.tokens, 'Owner 界面安装的令牌与打包资源不一致')
    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item => item.textContent === '安装到 Owner 工作区').click()`, true)
    await waitRenderer(window, `document.body.innerText.includes('目标存在冲突')`, '重复安装冲突提示')
    assert.equal((await window.webContents.executeJavaScript(`document.querySelectorAll('button').length && [...document.querySelectorAll('button')].some(item => item.textContent === '确认安装')`, true)), false, '存在冲突时仍提供确认安装入口')
    assert.equal(readInstalledOwnerDesignSystem(smokeOwnerWorkspace.slug)?.design, uiBundledReference.reference.design, '重复安装冲突改变了已安装内容')

    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item => item.textContent === '下载设计说明').click()`, true)
    const deadline = Date.now() + 10_000
    while ((downloads[0]?.state === 'started' || downloads.length === 0) && Date.now() < deadline) await sleep(50)
    assert.equal(downloads[0]?.state, 'completed', '设计说明未下载完成')
    assert(downloads[0].path.endsWith('stripe-DESIGN.md'))
    assert(readFileSync(downloads[0].path, 'utf8').includes('Design System Inspired by Stripe'))

    await window.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(item => item.textContent === '下载设计令牌').click()`, true)
    const tokensDeadline = Date.now() + 10_000
    while ((downloads[1]?.state === 'started' || downloads.length < 2) && Date.now() < tokensDeadline) await sleep(50)
    assert.equal(downloads[1]?.state, 'completed', '设计令牌未下载完成')
    assert(downloads[1].path.endsWith('stripe-tokens.css'))
    assert(readFileSync(downloads[1].path, 'utf8').includes(':root'))

    assert.equal(readFileSync(join(userWorkspace, 'DESIGN.md'), 'utf8'), 'USER_DESIGN_CANARY')
    assert.equal(readFileSync(join(userWorkspace, 'tokens.css'), 'utf8'), 'USER_TOKENS_CANARY')
    assert.deepEqual(readdirSync(userWorkspace).sort(), ['DESIGN.md', 'tokens.css'])
    assert(existsSync(join(process.resourcesPath, 'opendesign', 'LICENSE.txt')), 'OpenDesign 许可证未随包分发')
    return {
      downloads: downloads.map(item => ({ name: item.path.split('/').pop(), state: item.state })),
      ownerInstall: {
        brandName: installed.brandName, referenceRevision: installed.referenceRevision,
        serviceReadbackVerified: true, ownerUiConfirmationVerified: true, duplicateInstallBlocked: true,
      },
      userFilesUnchanged: true,
    }
  } finally {
    if (!window.isDestroyed()) window.destroy()
    setMainWindow(null)
    closeProjectDb()
  }
}
