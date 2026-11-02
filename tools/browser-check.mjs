/**
 * dsh-cot-en2cn — browser check.
 *
 * Loads the real `lib/client.js` in headless Chrome against a fixture page that
 * mimics ui-chat's reasoning rows, with a stub of the plugin's own routes. It
 * then asserts on the DOM Chrome prints back:
 *
 *   - a Chinese panel appears only under the rows a reader can actually read
 *     (expanded, or tall enough to be open, and no longer streaming)
 *   - two rows with the same text cost exactly one translate request
 *   - the original reasoning text is never touched
 *   - panel buttons do not bubble into the row's own expand/collapse handler
 *   - the master switch removes every panel again
 *   - the settings section mounts and renders its controls
 *
 * Run: node tools/browser-check.mjs [--chrome <path>]
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

const chromeFlag = process.argv.indexOf('--chrome')
const CHROME_CANDIDATES = [
  chromeFlag === -1 ? undefined : process.argv[chromeFlag + 1],
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter((value) => typeof value === 'string' && value !== '')

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (chrome === undefined) {
  process.stdout.write('no Chrome/Edge found; skipping the browser check\n')
  process.exit(0)
}

// [PATCH 2026-10-19 portable-react-umd] 原来这里硬编码了 P:\\dsh\\... 这类
// 原作者个人路径。路径不存在时**不报错**，而是让 settings fixture 被静默跳过
// （输出只剩一行 "skip no React UMD build found"），第三方机器等于少测一半且
// 毫无提示。改成按优先级解析：显式参数 → 本机 DSH profile → 常见全局路径 →
// 临时目录缓存 → 联网拉取，全失败才跳过（并且这次会**明确说出来**）。
const firstExisting = (candidates) => candidates.find((candidate) => existsSync(candidate))

/** DSH profile 的 node_modules 里通常有 react / react-dom（DSH 桌面版自带）。 */
function dshProfileReactCandidates() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const react = []
  const reactDom = []
  for (const profile of ['desktop', 'web']) {
    const nm = join(home, 'profiles', profile, 'node_modules')
    for (const file of ['react.development.js', 'react.production.min.js']) {
      react.push(join(nm, 'react', 'umd', file))
    }
    for (const file of ['react-dom.development.js', 'react-dom.production.min.js']) {
      reactDom.push(join(nm, 'react-dom', 'umd', file))
    }
  }
  return { react, reactDom }
}

const profileUmd = dshProfileReactCandidates()

const REACT_UMD = [
  ...(process.env.COT_EN2CN_REACT ? [process.env.COT_EN2CN_REACT] : []),
  ...profileUmd.react,
  '/usr/lib/node_modules/react/umd/react.development.js',
  '/usr/local/lib/node_modules/react/umd/react.development.js',
]
const REACT_DOM_UMD = [
  ...(process.env.COT_EN2CN_REACT_DOM ? [process.env.COT_EN2CN_REACT_DOM] : []),
  ...profileUmd.reactDom,
  '/usr/lib/node_modules/react-dom/umd/react-dom.development.js',
  '/usr/local/lib/node_modules/react-dom/umd/react-dom.development.js',
]

/** 联网拉 UMD 到临时目录（CDN 走 unpkg，与 live-lock-check.mjs 同一策略）。 */
async function fetchUmd(dir, name, url) {
  const target = join(dir, name)
  if (existsSync(target)) return target
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) return undefined
    writeFileSync(target, await res.text(), 'utf8')
    return target
  } catch {
    return undefined
  }
}

// 本地都找不到时联网兜底，避免"静默少测一半"。
let reactFile = firstExisting(REACT_UMD)
let reactDomFile = firstExisting(REACT_DOM_UMD)
if (reactFile === undefined || reactDomFile === undefined) {
  const umdCache = mkdtempSync(join(tmpdir(), 'session-translator-react-'))
  if (reactFile === undefined) {
    reactFile = await fetchUmd(umdCache, 'react.development.js', 'https://unpkg.com/react@18/umd/react.development.js')
  }
  if (reactDomFile === undefined) {
    reactDomFile = await fetchUmd(umdCache, 'react-dom.development.js', 'https://unpkg.com/react-dom@18/umd/react-dom.development.js')
  }
  // 明确告知走了哪条路，别让人以为测的是"仓库自带 React"。
  if (reactFile !== undefined && reactDomFile !== undefined) {
    process.stdout.write(`react UMD: fetched to ${umdCache}\n`)
  } else {
    process.stdout.write('react UMD: not found locally and the CDN fetch failed\n')
  }
}

// ------------------------------------------------------------------ stub host

const REASONING_A = 'I should check whether the settings service is even mounted before calling register on it.'
const REASONING_B = 'This block is collapsed, so a reader cannot see it and it must not be translated.'
const REASONING_C = 'The geometry fallback has to catch rows a build renders open without the data-expanded attribute on them.'
const REASONING_D = 'Streaming blocks are only translated when live translation is switched on explicitly.'

// [PATCH 2026-10-30 turn-follow] 回合跟随的样本：两轮各自一段思考，第三轮在
// 断言中途才插进来（模拟"用户发了下一条消息"）。
const TURN_TEXT_1 = 'The first turn finished a while ago and the reader has moved on, so this translation should fold away as soon as a newer turn exists.'
const TURN_TEXT_2 = 'The second turn is the newest one the reader is actually looking at, so its translation must stay open while it is the current turn.'
const TURN_TEXT_3 = 'A third turn has just arrived, which is what should fold the second turn away without touching anything the reader opened by hand.'
// [PATCH 2026-10-30 latest-only] 同一回合里的两个思考块。
const SPLIT_TEXT_A = 'The earlier reasoning block of the same turn has already been overtaken by a newer block, so its translation should be folded even though the turn is still the newest one.'
const SPLIT_TEXT_B = 'The later reasoning block of the same turn is the one the reader is actually waiting on, so its translation is the only one that stays open.'
// 译文框必须真的能滚，否则"跟随滚动"这条断言会退化成永远成立。
const TURN_LONG_TAIL = Array.from({ length: 40 }, (_unused, i) => 'line ' + (i + 1) + ': the translation keeps growing while the model is still thinking.').join(String.fromCharCode(10))
// [PATCH 2026-11-01 body-reveal] 显影回归样本：必须足够长，长到帧数够多，
// 采样才抓得到"中间态"。短句 0.26s 走完，取样窗口里只剩首末两帧。
const REVEAL_TEXT = Array.from({ length: 30 }, (_unused, i) => 'Paragraph ' + (i + 1) + ' of a translation that must appear gradually instead of landing as one block.').join(' ')
// [PATCH 2026-11-01 fold-anim] 收回动画的样本：正文必须够高，否则"中间高度"与
// 收起高度只差几个像素，采样分辨不出来（也说明不了读者能看到什么）。
const FOLD_TEXT_A = Array.from({ length: 14 }, (_unused, i) => 'Line ' + (i + 1) + ': this translation is tall enough that folding it back into the pill is visible even at a glance.').join(' ')

// [PATCH 2026-10-19 dropdown-row-squash] 模型下拉的回归样本：真机上
// workbuddy-ai 注册了 12 个模型，正是"候选总高超过 maxHeight 260px → flex
// 压缩每一行 → overflow:hidden 裁掉下半截"的触发条件。模型少时不会出现，
// 所以 fixture 必须真的给够数量，否则这条断言等于没测。
const SQUASH_MODELS = [
  'claude-sonnet-4-5-20250929',
  'claude-opus-4-1-20250805',
  'claude-haiku-4-5-20251001',
  'gpt-5-2025-08-07',
  'gpt-5-mini-2025-08-07',
  'gemini-2-5-pro',
  'gemini-2-5-flash',
  'deepseek-v3-1',
  'deepseek-r1-0528',
  'qwen3-max',
  'kimi-k2-0905',
  'glm-4-6',
].map((id) => ({ id, name: id }))

const CATALOG = [
  { id: 'workbuddy-ai', name: 'WorkBuddy AI', models: SQUASH_MODELS },
  { id: 'ollama', name: 'Ollama', models: [{ id: 'qwen2.5', name: 'qwen2.5' }] },
]

const server = {
  config: {
    enabled: true,
    autoTranslate: true,
    liveTranslate: false,
    targetLanguage: 'zh-CN',
    // [PATCH 2026-10-19 dropdown-row-squash] 默认渠道就用"模型很多"的那个：
    // 设置面板一渲染，「翻译模型」下拉里就有 12 个候选，才能覆盖压扁回归。
    provider: 'workbuddy-ai',
    model: SQUASH_MODELS[0].id,
    disableThinking: true,
    maxChunkChars: 3000,
    maxInputChars: 24000,
    timeoutMs: 120000,
    concurrency: 2,
    cacheEntries: 600,
    skipMostlyChinese: true,
    fontSizePx: 13,
    // [PATCH 2026-10-30 turn-follow] 回合跟随默认开，fixture 显式写出来，
    // 免得默认值一改，下面的回合断言变成静默失效。
    autoTurnFollow: true,
  },
  translateCalls: [],
  configWrites: [],
  cacheClears: 0,
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req) {
  let text = ''
  for await (const chunk of req) text += chunk
  return text === '' ? {} : JSON.parse(text)
}

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (path === '/dsh-session-translator/state') {
    jsonResponse(res, 200, {
      ok: true,
      version: '0.1.0-test',
      config: server.config,
      defaults: { ...server.config, enabled: true, provider: '', model: '' },
      configPath: 'C:\\temp\\session-translator\\config.json',
      configSource: 'file',
      route: { provider: server.config.provider, model: server.config.model, source: 'override' },
      stats: { requests: server.translateCalls.length, hits: 0, cacheSize: 0, lastMs: 12, lastError: null, lastRoute: `${server.config.provider}/${server.config.model}` },
      languages: [
        { id: 'zh-CN', label: '简体中文' },
        { id: 'zh-TW', label: '繁體中文' },
        { id: 'en', label: 'English' },
        { id: 'ja', label: '日本語' },
      ],
    })
    return
  }

  if (path === '/dsh-session-translator/catalog') {
    // [PATCH 2026-10-19 dropdown-row-squash] 设置 fixture 需要"模型很多"的渠道
    // 才能触发下拉行被压扁；模型少时该 bug 不出现，所以这里给足 12 个。
    jsonResponse(res, 200, { ok: true, providers: CATALOG })
    return
  }

  if (path === '/dsh-session-translator/models') {
    // [PATCH 2026-10-19 dropdown-row-squash] 面板进站时 Promise.all 同时拉
    // models + catalog；缺了 models 这条，readJson 会因 404 抛错，整个
    // Promise.all 直接 reject → catalog 永远为空 → 下拉退化成输入框。
    jsonResponse(res, 200, { ok: true, providers: [], ollama: { found: false, endpoint: '', models: [], probed: [], error: null } })
    return
  }

  if (path === '/dsh-session-translator/translate') {
    const body = await readBody(req)
    server.translateCalls.push(String(body.text ?? ''))
    // A small real delay so the loading state is observable.
    await new Promise((resolve) => setTimeout(resolve, 40))
    jsonResponse(res, 200, {
      ok: true,
      translation: `【中】${String(body.text ?? '')}`,
      skipped: null,
      chunks: 1,
      cached: false,
      route: { provider: 'fake', model: 'fake-1', source: 'override' },
      ms: 40,
    })
    return
  }

  if (path === '/dsh-session-translator/config') {
    const body = await readBody(req)
    server.configWrites.push(body)
    if (body !== null && typeof body.section === 'object' && body.section !== null) {
      Object.assign(server.config, body.section)
    }
    jsonResponse(res, 200, {
      ok: true,
      version: '0.1.0-test',
      config: server.config,
      defaults: { ...server.config, enabled: true, provider: '', model: '' },
      configPath: 'C:\\temp\\session-translator\\config.json',
      configSource: 'file',
      route: { provider: server.config.provider, model: server.config.model, source: 'override' },
      stats: { requests: server.translateCalls.length, hits: 0, cacheSize: 0, lastMs: 12, lastError: null, lastRoute: `${server.config.provider}/${server.config.model}` },
      languages: [{ id: 'zh-CN', label: '简体中文' }],
    })
    return
  }

  if (path === '/dsh-session-translator/cache/clear') {
    server.cacheClears += 1
    jsonResponse(res, 200, { ok: true, cleared: 3, stats: { requests: 1, hits: 3, cacheSize: 0, lastMs: 5, lastError: null, lastRoute: 'fake/fake-1' } })
    return
  }

  if (path === '/__stats') {
    jsonResponse(res, 200, { translateCalls: server.translateCalls, configWrites: server.configWrites.length, cacheClears: server.cacheClears })
    return
  }

  if (path === '/plugins/dsh-session-translator/client.js') {
    const body = readFileSync(join(root, 'lib', 'client.js'))
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(body)
    return
  }

  if (path === '/react.js' && reactFile !== undefined) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(readFileSync(reactFile))
    return
  }

  if (path === '/react-dom.js' && reactDomFile !== undefined) {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(readFileSync(reactDomFile))
    return
  }

  if (path === '/fixture.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(fixtureHtml())
    return
  }

  if (path === '/settings.html' && reactFile !== undefined && reactDomFile !== undefined) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(settingsHtml())
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found')
})

function shellFixtures() {
  return `
<style>
  body { font-family: sans-serif; margin: 0; padding: 16px; }
  .lcKema_root { display: flex; flex-direction: column; }
  .lcKema_root:not([data-expanded]) { height: 24px; overflow: hidden; }
  .lcKema_row { height: 24px; }
  .lcKema_thinkBody { white-space: pre-wrap; padding: 4px 0 4px 22px; }
  .tall { min-height: 140px; }
  /* [PATCH 2026-10-30 turn-follow] 回合样本：官方 flow item 的
     data-chat-turn 挂在每一行外面，插件只读它。 */
  .turn { margin: 8px 0; }
</style>
<!-- [PATCH 2026-11-01 body-reveal] 显影采样行：面板正文节点挂在这行下面时带
     id="reveal-host" 不可行（节点是插件建的），所以采样器按"父节点是这条推理行
     的面板"认领，见 fixture 脚本里的 revealSamples。 -->
<div class="lcKema_root" id="row-reveal" data-variant="think" data-state="ok" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REVEAL_TEXT}</div></div>
</div>
<div class="turn" data-chat-turn="1" id="turn-1">
  <div class="lcKema_root" id="row-turn-1" data-variant="think" data-state="ok" data-expanded>
    <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
    <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${TURN_TEXT_1}</div></div>
  </div>
</div>
<div class="turn" data-chat-turn="2" id="turn-2">
  <div class="lcKema_root" id="row-turn-2" data-variant="think" data-state="ok" data-expanded>
    <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
    <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${TURN_TEXT_2}</div></div>
  </div>
</div>
<!-- [PATCH 2026-10-30 latest-only] 同一个回合里两个思考块：只有最后那个该展开，
     前面的块属于同一回合但已经"过去了"。dsh-smooth-stream 的判据是 expanded=running。 -->
<div class="turn" data-chat-turn="3" id="turn-3-split">
  <div class="lcKema_root" id="row-split-a" data-variant="think" data-state="ok" data-expanded>
    <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
    <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${SPLIT_TEXT_A}</div></div>
  </div>
  <div class="lcKema_root" id="row-split-b" data-variant="think" data-state="ok" data-expanded>
    <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
    <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${SPLIT_TEXT_B}</div></div>
  </div>
</div>
<div class="lcKema_root" id="row-expanded" data-variant="think" data-state="ok" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_A}</div></div>
</div>
<div class="lcKema_root" id="row-duplicate" data-variant="think" data-state="ok" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_A}</div></div>
</div>
<div class="lcKema_root" id="row-collapsed" data-variant="think" data-state="ok">
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_B}</div></div>
</div>
<div class="lcKema_root tall" id="row-geometry" data-variant="think" data-state="ok">
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_C}</div></div>
</div>
<div class="lcKema_root" id="row-running" data-variant="think" data-state="running" data-expanded>
  <div class="lcKema_row"><span class="lcKema_title">思考</span></div>
  <div class="lcKema_bodywrap"><div class="lcKema_thinkBody">${REASONING_D}</div></div>
</div>
<pre id="report"></pre>
`
}

function fixtureHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>session-translator fixture</title></head>
<body>
${shellFixtures()}
<script>
  window.__report = []
  function log(name, ok, detail) { window.__report.push({ name: name, ok: ok === true, detail: detail === undefined ? '' : String(detail) }) }
  window.onerror = function (message) { log('window.onerror', false, message) }
  window.addEventListener('unhandledrejection', function (event) { log('unhandledrejection', false, String(event.reason)) })
  window.__ModuleLoader__ = { load: function (record) { window.__pluginRecord = record } }
</script>
<script src="/plugins/dsh-session-translator/client.js"></script>
<script>
  ;(async function () {
    try {
      var record = window.__pluginRecord
      log('bundle registered', record !== undefined && record.id === 'dsh-session-translator', record && record.id)
      var plugin = record.factory(function (name) {
        if (name === 'react') return { createElement: function () { return {} } }
        throw new Error('unexpected require: ' + name)
      })
      log('apply exported', typeof plugin.apply === 'function')

      // A row-level click listener stands in for DisclosureRow's own
      // expand/collapse handling: panel buttons must never reach it.
      document.getElementById('row-expanded').addEventListener('click', function () {
        window.__rowClicked = (window.__rowClicked || 0) + 1
      })

      var sections = []
      var slots = {
        inject: function (name, callback) { callback() },
        register: function (options, component) { sections.push({ options: options, component: component }); return function () {} },
      }
      plugin.apply({ get: function (name) { return name === 'slots' ? slots : undefined }, effect: function (fn) { return fn() } })
      // [PATCH 2026-11-02 settings-slot] 设置卡片从全局设置页的 list slot
      // （settings.section，靠 id 定址）挪进了插件详情页的 keyed slot
      // （plugins.bundle.config，靠 key 精确匹配裸包名）。断言跟着改：
      // key 对不上时宿主**整块不渲染且不报错**，所以这条正是唯一能守住它的地方。
      log('settings section registered',
        sections.length === 1 && sections[0].options.name === 'plugins.bundle.config'
          && sections[0].options.key === 'dsh-session-translator',
        sections.length === 1 ? JSON.stringify(sections[0].options) : String(sections.length))

      function panels() { return document.querySelectorAll('[data-dsh-session-translator="panel"]') }
      function translatedPanels() {
        return Array.prototype.filter.call(panels(), function (panel) { return /【中】/.test(panel.textContent) })
      }
      function panelIn(id) { var row = document.getElementById(id); return row === null ? null : row.querySelector('[data-dsh-session-translator="panel"]') }
      function waitFor(predicate, timeoutMs) {
        var deadline = Date.now() + timeoutMs
        return new Promise(function (resolve) {
          ;(function tick() {
            var value = null
            try { value = predicate() } catch (error) { value = null }
            if (value) { resolve(value); return }
            if (Date.now() > deadline) { resolve(null); return }
            setTimeout(tick, 60)
          })()
        })
      }

      // [PATCH 2026-11-01 body-reveal] 显影采样必须在**译文落地之前**挂上去：动画
      // 一落地就开始逐帧长出来，等译文数量够三个再来看，动画早跑完了。
      // 观察 document.body 上所有字符数据变化，事后按文本前缀认领显影行那一条。
      var revealSamples = []
      var revealObserver = new MutationObserver(function (records) {
        for (var r = 0; r < records.length; r += 1) {
          if (records[r].type !== 'characterData') continue
          var data = String(records[r].target.data === undefined ? '' : records[r].target.data)
          if (data.indexOf('【中】Paragraph 1') === 0) revealSamples.push(data.length)
        }
      })
      revealObserver.observe(document.body, { subtree: true, characterData: true })

      // [PATCH 2026-11-01 body-reveal] 显影让"译文已经出现"变成一个**过程**：
      // 正文先为空、再逐帧长出。凡是断言具体文本的地方都必须先等显影落地，
      // 否则量到的是半句话——那不是回归，是采样跑在动画前面。
      function noRevealInFlight() { return document.querySelectorAll('[data-dsh-session-translator-revealing]').length === 0 }
      async function settleReveals() {
        await waitFor(noRevealInFlight, 8000)
        await new Promise(function (resolve) { setTimeout(resolve, 40) })
      }

      var ok = await waitFor(function () { return translatedPanels().length >= 3 }, 12000)
      log('three rows translated', ok !== null, translatedPanels().length)

      // 面板是"先出空正文、再逐帧长出"的，任何按文本断言的检查都必须等显影落地。
      await settleReveals()
      var expanded = panelIn('row-expanded')
      var duplicate = panelIn('row-duplicate')
      var geometry = panelIn('row-geometry')
      log('expanded row translated', expanded !== null && /【中】/.test(expanded.textContent), expanded ? expanded.textContent.slice(0, 40) : 'missing')
      log('duplicate row translated from cache', duplicate !== null && /【中】/.test(duplicate.textContent))
      log('open-by-geometry row translated', geometry !== null && /【中】/.test(geometry.textContent))
      log('collapsed row untouched', panelIn('row-collapsed') === null)
      var runningPanel = panelIn('row-running')
      log(
        'streaming row shows a status, not a translation',
        runningPanel !== null && runningPanel.textContent.indexOf('【中】') === -1 && /自动翻译/.test(runningPanel.textContent),
        runningPanel === null ? 'no panel' : runningPanel.textContent.slice(0, 40),
      )

      // The original reasoning text must survive verbatim.
      var original = document.querySelector('#row-expanded .lcKema_thinkBody').textContent
      log('original text preserved', original === ${JSON.stringify(REASONING_A)}, original.slice(0, 30))

      // [PATCH 2026-11-01 body-reveal] 显影：译文不许一整块落地。
      var revealPanel = panelIn('row-reveal')
      var revealBody = revealPanel === null ? null : revealPanel.querySelector('[data-role="body"]')
      var revealFull = '【中】' + ${JSON.stringify(REVEAL_TEXT)}
      // 先等它真的开始长（半个窗口内必然出现中间态），再等落定。直接等落定会把
      // "有没有中间态"让给采样计数，而采样在慢机器上可能一帧都没赶上。
      var revealStarted = await waitFor(function () {
        return revealBody !== null && revealBody.getAttribute('data-dsh-session-translator-revealing') === '1'
          && revealBody.textContent.length > 0 && revealBody.textContent.length < revealFull.length
      }, 8000)
      var revealDone = await waitFor(function () {
        return revealBody !== null && revealBody.textContent === revealFull
      }, 8000)
      log('the translation does not land as one block',
        revealStarted !== null || revealSamples.some(function (n) { return n > 0 && n < revealFull.length }),
        'started=' + (revealStarted !== null) + ' samples=' + revealSamples.length + ' lens=' + JSON.stringify(revealSamples.slice(0, 6)))
      log('the reveal ends on the whole translation',
        revealDone !== null,
        revealBody === null ? 'no body' : String(revealBody.textContent.length) + '/' + revealFull.length)
      log('the reveal only ever grows',
        revealSamples.every(function (n, i) { return i === 0 || n >= revealSamples[i - 1] }),
        JSON.stringify(revealSamples.slice(0, 8)))
      // 复制按钮不能在显影途中复制出半句话。
      if (revealPanel !== null) {
        var revealCopy = revealPanel.querySelector('[data-act="copy"]')
        var copied = ''
        var clipboardAvailable = navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function'
        if (clipboardAvailable) {
          var originalWrite = navigator.clipboard.writeText.bind(navigator.clipboard)
          navigator.clipboard.writeText = function (value) { copied = String(value); return Promise.resolve() }
          var retryForCopy = revealPanel.querySelector('[data-act="retry"]')
          if (retryForCopy !== null) retryForCopy.click()
          await new Promise(function (resolve) { setTimeout(resolve, 60) })
          if (revealCopy !== null) revealCopy.click()
          navigator.clipboard.writeText = originalWrite
        }
        log('copying mid-reveal yields the whole translation',
          clipboardAvailable !== true || copied === revealFull,
          clipboardAvailable !== true ? 'clipboard unavailable' : String(copied.length) + '/' + revealFull.length)
      }

      var stats = await (await fetch('/__stats', { cache: 'no-store' })).json()
      // [PATCH 2026-10-30 turn-follow] fixture 里多了两段回合样本（TURN_TEXT_1/2），
      // 所以"两条不同文本"的旧口径变成四条。改断言而不是改 fixture：丢样本会让
      // 回合断言失去可翻译的真实内容。
      // [PATCH 2026-10-30 latest-only] fixture 又多了同轮两块样本，四 → 六。
      // [PATCH 2026-11-01 body-reveal] 口径改成「每段不同的思考各请求一次」：显影
      // 相关的重译（点「重新翻译」验证复制）会让总次数随测试步骤漂，而这条断言真正
      // 要守的是"不同文本不重复请求"。
      var distinctCalls = stats.translateCalls.filter(function (t, i, all) { return all.indexOf(t) === i })
      // 总次数不再固定：验证"显影途中复制"会主动点一次「重新翻译」，那是 force
      // 重译，本就该多一次请求。这条只守"七段不同的思考都各自请求到了"。
      log('every distinct thinking block is requested',
        distinctCalls.length === 7,
        'distinct=' + distinctCalls.length + ' total=' + stats.translateCalls.length)
      log('identical text requested once', stats.translateCalls.filter(function (t) { return t === ${JSON.stringify(REASONING_A)} }).length === 1)
      log('collapsed text never requested', stats.translateCalls.indexOf(${JSON.stringify(REASONING_B)}) === -1)
      log('streaming text never requested', stats.translateCalls.indexOf(${JSON.stringify(REASONING_D)}) === -1)

      // [PATCH 2026-10-30 head-click] 「收起/展开」按钮已撤，整个头胶囊是开关。
      // [PATCH 2026-10-30 drop-orig] 「思考原文」按钮与面板内原文块已删：
      // 官方思考行自己可点，面板不该再做一遍。
      var staleOrig = expanded.querySelector('[data-act="orig"]')
      var staleOrigBlock = expanded.querySelector('[data-role="orig"]')
      log('the original-text button is gone', staleOrig === null && staleOrigBlock === null,
        staleOrig === null ? (staleOrigBlock === null ? '' : 'orig block still present') : 'orig button still present')

      // Panel buttons must stop propagation into the row handler.
      window.__rowClicked = 0
      var head = expanded.querySelector('[data-role="head"]')
      var copy = expanded.querySelector('[data-act="copy"]')
      var staleToggle = expanded.querySelector('[data-act="toggle"]')
      log('the separate collapse button is gone', staleToggle === null, staleToggle === null ? '' : 'still present')
      log('the panel head is the toggle', head !== null && copy !== null)
      var body = expanded.querySelector('[data-role="body"]')
      // 点头胶囊 = 收起（官方 DisclosureRow 的整行点击）
      head.click()
      log('clicking the head collapses the translation', body !== null && body.getAttribute('data-collapsed') === 'true')
      log('head click does not bubble into the row', window.__rowClicked === 0, window.__rowClicked)
      head.click()
      log('clicking the head again restores it', body !== null && body.getAttribute('data-collapsed') === 'false')
      // 按钮仍然只做自己的事，不能顺带把面板收起（否则「复制」会关掉译文）
      copy.click()
      log('action buttons do not toggle the panel', body !== null && body.getAttribute('data-collapsed') === 'false')
      log('buttons do not bubble into the row', window.__rowClicked === 0, window.__rowClicked)

      // [PATCH 2026-10-30 head-click] 拖选不能误触：从头按下拖到正文再松手，
      // 面板不该收起。用 pointer 事件模拟（浏览器在 click 前已可能收起选区，
      // 所以判据是拖拽距离而不是选区状态）。
      var dragHead = expanded.querySelector('[data-role="head"]')
      var dragBody = expanded.querySelector('[data-role="body"]')
      var rectBase = dragHead.getBoundingClientRect ? dragHead.getBoundingClientRect() : { left: 10, top: 10 }
      dragHead.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, buttons: 1, clientX: rectBase.left + 5, clientY: rectBase.top + 5 }))
      dragHead.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, buttons: 1, clientX: rectBase.left + 120, clientY: rectBase.top + 60 }))
      dragHead.click()
      log('a drag that starts on the head does not toggle the panel',
        dragBody !== null && dragBody.getAttribute('data-collapsed') === 'false',
        dragBody === null ? 'no body' : dragBody.getAttribute('data-collapsed'))
      // [PATCH 2026-10-30 turn-follow] 回合跟随：当前回合展开、旧回合收成一行、
      // 手动展开的闩锁不被抢、译文框自己跟到底。
      var turn1 = panelIn('row-turn-1')
      var turn2 = panelIn('row-turn-2')
      var bodyOf = function (panel) { return panel === null ? null : panel.querySelector('[data-role="body"]') }
      var collapsedOf = function (panel) {
        var b = bodyOf(panel)
        return b === null ? 'missing' : b.getAttribute('data-collapsed')
      }
      log('both turns translated', turn1 !== null && turn2 !== null && /【中】/.test(turn1.textContent) && /【中】/.test(turn2.textContent),
        collapsedOf(turn1) + '/' + collapsedOf(turn2))
      // [PATCH 2026-10-30 latest-only] 展开单位改成"文档最末尾那一个思考块"后，
      // turn-2 不再是尾块（turn-3 的两块在它后面），所以它也该收起。真正的
      // "最新还开着"由下面的 latest-only 一组断言守（split-b）。
      log('every non-tail turn folds to one line', collapsedOf(turn2) === 'true', collapsedOf(turn2))
      log('the older turn folds to one line', collapsedOf(turn1) === 'true', collapsedOf(turn1))

      // 读者手动展开旧回合 → 闩锁，此后新回合也不会把它收回。
      bodyOf(turn1).click()
      log('clicking the folded preview expands the older turn', collapsedOf(turn1) === 'false', collapsedOf(turn1))

      // 第三轮到达（用户发了下一条消息）：旧回合该收，但闩锁的那一条不动。


      var turn3 = document.createElement('div')
      turn3.className = 'turn'
      turn3.setAttribute('data-chat-turn', '3')
      turn3.id = 'turn-3'
      turn3.innerHTML = '<div class="lcKema_root" id="row-turn-3" data-variant="think" data-state="ok" data-expanded>' +
        '<div class="lcKema_row"><span class="lcKema_title">思考</span></div>' +
        '<div class="lcKema_bodywrap"><div class="lcKema_thinkBody">' + ${JSON.stringify(TURN_TEXT_3)} + '</div></div></div>'
      document.body.appendChild(turn3)
      // [PATCH 2026-11-01 body-reveal] 面板先于译文存在（建节点 → 发请求 → 逐帧显影），
      // 只等"面板出现"会读到空正文。这里等的是**译文真的写进去了**。
      var turn3Panel = await waitFor(function () {
        var p = panelIn('row-turn-3')
        return p !== null && /【中】/.test(p.textContent) ? p : null
      }, 12000)
      await settleReveals()
      log('the arriving turn is translated', turn3Panel !== null && /【中】/.test(turn3Panel.textContent))
      await waitFor(function () { return collapsedOf(turn2) === 'true' }, 12000)
      log('a newer turn folds the previous one', collapsedOf(turn2) === 'true', collapsedOf(turn2))
      log('a panel the reader opened is never auto-folded', collapsedOf(turn1) === 'false', collapsedOf(turn1))
      // [PATCH 2026-10-30 latest-only] 这就是"最末尾那个块保持展开"的正向断言。
      log('the tail block of the newest turn stays open', collapsedOf(turn3Panel) === 'false', collapsedOf(turn3Panel))

      // 跟随滚动：译文超过限高框时，框内应自动跟到底（除非读者上滚）。
      var scrollBody = bodyOf(turn3Panel)
      scrollBody.style.maxHeight = '80px'
      scrollBody.style.overflowY = 'auto'
      scrollBody.textContent = ${JSON.stringify(TURN_LONG_TAIL)}
      var retryButton = turn3Panel.querySelector('[data-act="retry"]')
      if (retryButton !== null) retryButton.click()
      await new Promise(function (resolve) { setTimeout(resolve, 900) })
      log('the translation box follows its own bottom',
        scrollBody.scrollHeight - scrollBody.scrollTop - scrollBody.clientHeight <= 30,
        scrollBody.scrollTop + '/' + (scrollBody.scrollHeight - scrollBody.clientHeight))

      // 读者上滚 → 接管，不再被拽回底部。
      scrollBody.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
      scrollBody.scrollTop = 0
      var retry2 = turn3Panel.querySelector('[data-act="retry"]')
      if (retry2 !== null) retry2.click()
      await new Promise(function (resolve) { setTimeout(resolve, 900) })
      log('scrolling up hands the position to the reader', scrollBody.scrollTop <= 30, scrollBody.scrollTop)
      // [PATCH 2026-10-30 latest-only] 同一回合里两块思考：只展开最后那块。
      // 这一条是"按回合"与"按最末尾块"两种实现的唯一区分点，缺了它两种写法都绿。
      var splitA = panelIn('row-split-a')
      var splitB = panelIn('row-split-b')
      var splitReady = await waitFor(function () {
        return splitA !== null && splitB !== null && /【中】/.test(splitA.textContent) && /【中】/.test(splitB.textContent)
      }, 15000)
      log('both blocks of one turn get translated', splitReady !== null)
      // 此刻文档末尾是运行时追加的 row-turn-3（第三轮），所以 split-b 也不再是尾块。
      // "尾块保持展开"由下一组断言（turn-3 自己的面板）守，这里只断言被越过的那块收了。
      log('an overtaken block folds even inside the newest turn', collapsedOf(splitA) === 'true', collapsedOf(splitA))
      log('a later block of the same turn is folded once a newer turn arrives', collapsedOf(splitB) === 'true', collapsedOf(splitB))
      // 关掉回合跟随：已收起的旧回合必须重新展开（"关掉即恢复"，不是只停用规则）。
      await fetch('/dsh-session-translator/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section: { autoTurnFollow: false } }),
      })
      document.dispatchEvent(new Event('visibilitychange'))
      var reopened = await waitFor(function () { return collapsedOf(turn2) === 'false' }, 20000)
      log('turning the setting off re-expands the folded turns', reopened !== null, collapsedOf(turn2))
      // [PATCH 2026-10-30 row-window] 长会话回归：曾经只对账文档前 80 行，
      // 最新几轮排在末尾永远轮不到（历史有译文、最新一条没有，且不报错）。
      // fixture 塞 100 个早期回合 + 末尾新回合，断言末尾那条照样出译文。
      var bulk = document.createElement('div')
      bulk.id = 'long-history'
      var bulkHtml = ''
      for (var hi = 0; hi < 100; hi += 1) {
        bulkHtml += '<div class="turn" data-chat-turn="' + (10 + hi) + '">' +
          '<div class="lcKema_root" data-variant="think" data-state="ok">' +
          '<div class="lcKema_row"><span class="lcKema_title">思考</span></div>' +
          '<div class="lcKema_bodywrap"><div class="lcKema_thinkBody">History row ' + hi + ' sits far above the window and must not starve the newest turn of a translation.</div></div></div></div>'
      }
      bulk.innerHTML = bulkHtml
      document.body.insertBefore(bulk, document.body.firstChild)
      // 断言必须是「面板消失后能重建」，不能是「面板一直在」：turn-3 早就有了
      // 自己的面板，只等它存在等于什么都没测（旧实现下同样会绿）。
      var newestRow = document.getElementById('row-turn-3')
      var newestHost = newestRow === null ? null : newestRow.parentElement
      var stalePanels = newestHost === null ? [] : newestHost.querySelectorAll('[data-dsh-session-translator="panel"]')
      for (var si = 0; si < stalePanels.length; si += 1) stalePanels[si].remove()
      // 面板的译文来自客户端缓存，重建不会再打模型——所以这里测的是「对账窗口
      // 覆盖不覆盖末尾」，与网络无关。
      var rebuilt = await waitFor(function () {
        var p = newestHost === null ? null : newestHost.querySelector('[data-dsh-session-translator="panel"]')
        return p !== null ? p : null
      }, 20000)
      log('a 100-row history does not starve the newest turn',
        rebuilt !== null,
        rebuilt === null ? 'the newest row never got its panel back' : 'rebuilt')
      // 再推进一轮：只有末尾被重新翻译，才说明它真的在对账窗口里。
      var retranslated = await waitFor(function () {
        var p = newestHost === null ? null : newestHost.querySelector('[data-dsh-session-translator="panel"]')
        return p !== null && /【中】/.test(p.textContent) ? p : null
      }, 20000)
      log('the rebuilt panel on a long transcript carries the translation',
        retranslated !== null,
        retranslated === null ? 'panel present but empty' : 'translated')

      // [PATCH 2026-11-01 fold-anim] 收回必须看得出来。判据不是「最终收起了」
      // （瞬切的终点值完全一样），而是途中量到一个中间高度：
      //   展开高度 > 过渡中高度 > 收起高度，且这段期间正文带 data-folding。
      // 样本必须是长译文：一行字的正文与收起高度只差几像素，量不出中间态。
      var foldTurn = document.createElement('div')
      foldTurn.className = 'turn'
      // 回合号必须比 bulk 历史（10..109）更大：否则它会被"非尾回合"规则收起，
      // 量到的是一个已经收起的框，收回动画根本不会发生。
      foldTurn.setAttribute('data-chat-turn', '200')
      foldTurn.id = 'turn-fold'
      foldTurn.innerHTML = '<div class="lcKema_root" id="row-fold" data-variant="think" data-state="ok" data-expanded>' +
        '<div class="lcKema_row"><span class="lcKema_title">思考</span></div>' +
        '<div class="lcKema_bodywrap"><div class="lcKema_thinkBody">' + ${JSON.stringify(FOLD_TEXT_A)} + '</div></div></div>'
      document.body.appendChild(foldTurn)
      var foldPanel = await waitFor(function () {
        var p = panelIn('row-fold')
        return p !== null && /【中】/.test(p.textContent) ? p : null
      }, 20000)
      await settleReveals()
      var foldBody = foldPanel === null ? null : foldPanel.querySelector('[data-role="body"]')
      var foldHead = foldPanel === null ? null : foldPanel.querySelector('[data-role="head"]')
      log('the fold sample row is open and translated',
        foldBody !== null && foldHead !== null && foldBody.getAttribute('data-collapsed') === 'false',
        foldBody === null ? 'no body' : foldBody.getAttribute('data-collapsed'))
      // [PATCH 2026-11-02 fold-on-screen] 收回动画现在只给视口内的正文播
      // （屏幕外/新建的先不要那 23ms+120 个 rAF）。所以样本必须先滚进视口，
      // 否则量到的是"直接落定"，中间高度当然不存在。
      foldPanel.scrollIntoView({ block: 'center' })
      await new Promise(function (resolve) { setTimeout(resolve, 120) })
      var openHeight = foldBody.getBoundingClientRect().height
      foldHead.click()
      var midHeight = foldBody.getBoundingClientRect().height
      var midFolding = foldBody.getAttribute('data-folding')
      await new Promise(function (resolve) { setTimeout(resolve, 340) })
      var endHeight = foldBody.getBoundingClientRect().height
      log('folding runs through an intermediate height',
        midFolding === '1' && midHeight > endHeight + 4 && midHeight < openHeight - 4,
        'open=' + Math.round(openHeight) + ' mid=' + Math.round(midHeight) + ' end=' + Math.round(endHeight) + ' folding=' + midFolding)
      log('folding settles on the one-line height',
        endHeight > 0 && endHeight < openHeight / 2 && foldBody.getAttribute('data-folding') === null,
        'open=' + Math.round(openHeight) + ' end=' + Math.round(endHeight) + ' folding=' + foldBody.getAttribute('data-folding')
          + ' collapsed=' + foldBody.getAttribute('data-collapsed')
          + ' latch=' + (foldPanel.dataset.manualClosed || '-') + '/' + (foldPanel.dataset.manualOpen || '-')
          + ' state=' + foldPanel.dataset.state)
      // 收完之后还要能正常展开（过渡标记必须撤干净，否则下次切换会重放动画）。
      foldHead.click()
      await new Promise(function (resolve) { setTimeout(resolve, 340) })
      log('reopening after a fold restores the full height',
        foldBody.getBoundingClientRect().height >= openHeight - 4 && foldBody.getAttribute('data-folding') === null,
        'now=' + Math.round(foldBody.getBoundingClientRect().height) + ' want=' + Math.round(openHeight)
          + ' collapsed=' + foldBody.getAttribute('data-collapsed')
          + ' folding=' + foldBody.getAttribute('data-folding')
          + ' text=' + foldBody.textContent.length
          + ' ws=' + getComputedStyle(foldBody).whiteSpace
          + ' maxh=' + getComputedStyle(foldBody).maxHeight
          + ' hidden=' + foldBody.hidden)
      // 读者亲手收起**当前回合那一块**之后，220ms 一次的对账不许把它重新摊开。
      // 这是手册风险 #23 第二条缺失的回归：只有正向断言（当前回合会展开）时，
      // 把 manualClosed 判断删掉照样全绿。
      // 先把回合跟随恢复成开：下面这条要验的正是**自动回合规则**会不会去重新摊开
      // 读者亲手收起的那一块。关着的时候走的是另一条分支（"关掉即恢复"），
      // 测不到 applyTurnFollow 里的 manualClosed 闸门。
      await fetch('/dsh-session-translator/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section: { autoTurnFollow: true } }),
      })
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise(function (resolve) { setTimeout(resolve, 800) })
      if (foldBody.getAttribute('data-collapsed') !== 'true') foldHead.click()
      await new Promise(function (resolve) { setTimeout(resolve, 340) })
      // 必须**主动逼一次对账**：移除本闸门时，若没有新的 DOM 变动，MutationObserver
      // 不会自己触发，sync() 根本不跑——断言于是两种实现都绿（实测踩过）。
      // visibilitychange 会走 refresh() → safeSync()，是确定性的触发点。
      document.dispatchEvent(new Event('visibilitychange'))
      await new Promise(function (resolve) { setTimeout(resolve, 900) })   // 跨过至少三次对账
      log('a block the reader closed by hand stays closed',
        foldBody.getAttribute('data-collapsed') === 'true' && foldPanel.dataset.manualOpen === undefined,
        'collapsed=' + foldBody.getAttribute('data-collapsed') + ' open=' + (foldPanel.dataset.manualOpen || '-') + ' closed=' + (foldPanel.dataset.manualClosed || '-'))
      // 显影途中被收起：文字必须落到终稿，不能停在半句话（展开了也不会自愈）。
      if (foldPanel !== null) {
        foldHead.click()   // 展开
        await new Promise(function (resolve) { setTimeout(resolve, 340) })
        var fullLength = ('【中】' + ${JSON.stringify(FOLD_TEXT_A)}).length
        // 重译出来的还是同一段文字，而正文已经是它——revealInto 会走"前缀已到终点"
        // 的分支直接落定，根本没有中间态可测。先把正文截短成前缀，制造一次真正的
        // 补写型显影（对应 live 追赶那种"同一句话在变长"的场景）。
        foldBody.textContent = foldBody.textContent.slice(0, 120)
        var retryWhileRevealing = foldPanel.querySelector('[data-act="retry"]')
        if (retryWhileRevealing !== null) retryWhileRevealing.click()
        // 不能用固定延时等"显影进行中"：请求什么时候回来是不确定的，90ms 时正文
        // 可能还是上一稿的完整文本，量到的 mid 就等于 full，这条断言会静默失效
        // （踩过）。等的是那个确定的中间态：带 revealing 标记且长度严格小于终稿。
        var midState = await waitFor(function () {
          if (foldBody.getAttribute('data-dsh-session-translator-revealing') !== '1') return null
          var n = foldBody.textContent.length
          return n > 0 && n < fullLength ? n : null
        }, 8000)
        var midRevealLength = midState === null ? -1 : midState
        foldHead.click()   // 显影途中收起
        await new Promise(function (resolve) { setTimeout(resolve, 60) })
        log('collapsing mid-reveal lands the finished translation',
          midRevealLength > 0 && foldBody.textContent.length === fullLength,
          'mid=' + midRevealLength + ' after=' + foldBody.textContent.length + ' full=' + fullLength)
      }
      // Master switch off: every panel goes away.
      await fetch('/dsh-session-translator/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ section: { enabled: false } }),
      })
      document.dispatchEvent(new Event('visibilitychange'))
      var gone = await waitFor(function () { return panels().length === 0 }, 20000)
      log('disabling removes every panel', gone !== null, panels().length)

      document.getElementById('report').textContent = JSON.stringify(window.__report)
    } catch (error) {
      log('harness crashed', false, (error && error.stack) || String(error))
      document.getElementById('report').textContent = JSON.stringify(window.__report)
    }
  })()
</script>
</body></html>`
}

function settingsHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>session-translator settings</title></head>
<body>
<div id="root"></div>
<pre id="report"></pre>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>window.__ModuleLoader__ = { load: function (record) { window.__pluginRecord = record } }</script>
<script src="/plugins/dsh-session-translator/client.js"></script>
<script>
  var SQUASH_IDS = ${JSON.stringify(SQUASH_MODELS.map((model) => model.id))}
  var SQUASH_FIRST_ID = ${JSON.stringify(SQUASH_MODELS[0].id)}
</script>
<script>
  ;(async function () {
    var report = []
    function log(name, ok, detail) { report.push({ name: name, ok: ok === true, detail: detail === undefined ? '' : String(detail) }) }
    window.onerror = function (message) { log('window.onerror', false, message) }
    try {
      var plugin = window.__pluginRecord.factory(function (name) {
        if (name === 'react') return window.React
        throw new Error('unexpected require: ' + name)
      })
      var sections = []
      var slots = {
        inject: function (name, callback) { callback() },
        register: function (options, component) { sections.push({ options: options, component: component }); return function () {} },
      }
      plugin.apply({ get: function (name) { return name === 'slots' ? slots : undefined }, effect: function (fn) { return fn() } })
      log('section registered', sections.length === 1, String(sections.length))
      // keyed slot 没有 label()（标题走 locale 的 meta.title），旧的 label 断言
      // 在迁移后必然抛 TypeError，把整段后续断言一起带走——所以这里只守 key。
      log('section key matches the bare package name',
        sections.length === 1 && sections[0].options.key === 'dsh-session-translator',
        sections.length === 1 ? String(sections[0].options.key) : '')

      var root = window.ReactDOM.createRoot(document.getElementById('root'))
      root.render(window.React.createElement(sections[0].component))

      var deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        var text = document.getElementById('root').textContent
        // 必须等 catalog 拉到、模型下拉换成「有候选」形态（触发器显示模型名）
        // 再断言，否则量到的是还没加载候选时的输入框形态。
        if (text.indexOf('翻译模型') !== -1 && text.indexOf(SQUASH_FIRST_ID) !== -1) break
        await new Promise(function (resolve) { setTimeout(resolve, 80) })
      }
      var rendered = document.getElementById('root').textContent
      // [PATCH 2026-10-19 stale-settings-assertions] 这几条断言写的是第十轮之前
      // 的旧面板（"展开时自动翻译" / "用默认模型" / 配置文件路径行），那些文案与
      // 控件早已在面板重做时删除，断言却没人更新 —— 结果永远 FAIL，掩盖真实回归。
      // 现在改成断言**当前面板的稳定锚点**：六张卡片标题 + 保存栏 + 关键控件。
      log('renders the status card', rendered.indexOf('workbuddy-ai') !== -1, rendered.slice(0, 60))
      log('renders six group cards',
        ['基础', '翻译模式', '翻译模型', '备用路由', '高级', '试译'].every(function (name) {
          return rendered.indexOf(name) !== -1
        }))
      log('renders basic switches', rendered.indexOf('启用 CoT 中文翻译') !== -1 && rendered.indexOf('思考过程中也翻译') !== -1)
      log('renders model fields', rendered.indexOf('翻译模型') !== -1 && rendered.indexOf('拉取模型列表') !== -1)
      log('renders advanced knobs', rendered.indexOf('目标语言') !== -1 && rendered.indexOf('单次请求上限') !== -1 && rendered.indexOf('并发请求数') !== -1)
      log('renders the save bar', rendered.indexOf('保存') !== -1 && rendered.indexOf('放弃改动') !== -1)
      log('renders the test box', rendered.indexOf('试译') !== -1)
      log('renders no crash text', rendered.indexOf('Something went wrong') === -1)

      // [PATCH 2026-10-20 save-bar-top] 回归：保存栏必须在**第一张卡片之前**。
      // 曾经它在 6 张卡片之后、面板最底部（整页高近 1800px），改完任意一项都得
      // 滚到底才能保存，使用者反馈"保存按钮很难发现"。现在固定在状态区正下方。
      //
      // 定位方式：设置面板没有 PANEL_ATTR（那个属性只给译文面板用），
      // 所以从 #root 往下找「直接包含 6 个 section 的那个 div」= styles.panel。
      {
        var panelEl = null
        var candidates = Array.prototype.slice.call(document.querySelectorAll('#root div'))
        for (var c = 0; c < candidates.length; c += 1) {
          var secCount = 0
          for (var k = 0; k < candidates[c].children.length; k += 1) {
            if (candidates[c].children[k].tagName.toLowerCase() === 'section') secCount += 1
          }
          if (secCount >= 6) { panelEl = candidates[c]; break }
        }
        var saveIndex = -1
        var firstCardIndex = -1
        if (panelEl !== null) {
          var nodes = Array.prototype.slice.call(panelEl.children)
          for (var n = 0; n < nodes.length; n += 1) {
            if (firstCardIndex === -1 && nodes[n].tagName.toLowerCase() === 'section') firstCardIndex = n
            if (saveIndex === -1 && nodes[n].textContent.indexOf('放弃改动') !== -1) saveIndex = n
          }
        }
        log('settings panel found', panelEl !== null)
        log('save bar sits above the first card', saveIndex !== -1 && firstCardIndex !== -1 && saveIndex < firstCardIndex,
          'saveIndex=' + saveIndex + ' firstCard=' + firstCardIndex)
        log('save bar is not last', panelEl !== null && saveIndex !== -1 && saveIndex < panelEl.children.length - 1,
          panelEl === null ? 'no panel' : saveIndex + '/' + panelEl.children.length)
      }

      var buttons = Array.prototype.slice.call(document.querySelectorAll('#root button'))
      log('has buttons', buttons.length >= 3, buttons.length)
      var clearButton = buttons.filter(function (button) { return button.textContent.indexOf('清空服务端缓存') !== -1 })[0]
      if (clearButton !== undefined) {
        clearButton.click()
        await new Promise(function (resolve) { setTimeout(resolve, 300) })
      }
      var stats = await (await fetch('/__stats', { cache: 'no-store' })).json()
      log('clear cache button hits the host', stats.cacheClears === 1, stats.cacheClears)

      // [PATCH 2026-10-19 dropdown-row-squash] 回归：模型多的渠道下，下拉每一行
      // 必须保持完整高度。曾经的 bug 是 dropdownMenu 为 flex 纵向容器，选项
      // 按钮作为 flex item 默认 flex-shrink:1，候选总高超过 maxHeight(260) 时
      // flex 先把每行从 30px 压到 18px，再被 overflow:hidden 裁掉下半截 ——
      // 表现为"下一行遮住上一行的下半截"。模型少时不会出现，所以这里必须
      // 点开一个真有 12 个候选的下拉来量。
      var trigger = Array.prototype.slice.call(document.querySelectorAll('#root button'))
        .filter(function (b) { return b.textContent.indexOf(SQUASH_FIRST_ID) !== -1 })[0]
      if (trigger === undefined) {
        log('model dropdown trigger found', false, 'no button showing ' + SQUASH_FIRST_ID)
      } else {
        trigger.click()
        await new Promise(function (resolve) { setTimeout(resolve, 250) })
        var optionButtons = Array.prototype.slice.call(document.querySelectorAll('#root button'))
          .filter(function (b) {
            var text = b.textContent.trim()
            if (/[▲▼]/.test(text)) return false
            return SQUASH_IDS.some(function (id) { return text.indexOf(id) !== -1 })
          })
        log('model dropdown lists every model', optionButtons.length === SQUASH_IDS.length,
          optionButtons.length + '/' + SQUASH_IDS.length)
        var squashed = optionButtons.filter(function (b) { return b.offsetHeight < b.scrollHeight })
        log('no model row is squashed', optionButtons.length > 0 && squashed.length === 0,
          squashed.length + '/' + optionButtons.length + ' rows clipped')
        // 行距必须 >= 行自身内容高，否则就是"下行压上行"。
        var overlap = 0
        for (var i = 1; i < optionButtons.length; i += 1) {
          var prev = optionButtons[i - 1]
          var gap = optionButtons[i].getBoundingClientRect().top - prev.getBoundingClientRect().top
          if (gap + 0.5 < prev.scrollHeight) overlap += 1
        }
        log('no model row overlaps the one above', optionButtons.length > 1 && overlap === 0,
          overlap + ' overlapping rows')
        // 下拉自己必须是可滚动容器，而不是把行压扁来塞下。
        var menu = optionButtons.length === 0 ? null : optionButtons[0].parentElement
        log('dropdown scrolls instead of shrinking rows',
          menu !== null && menu.scrollHeight > menu.clientHeight &&
            getComputedStyle(menu).overflowY === 'auto',
          menu === null ? 'no menu' : menu.scrollHeight + ' > ' + menu.clientHeight)
        trigger.click()
      }

      document.getElementById('report').textContent = JSON.stringify(report)
    } catch (error) {
      log('harness crashed', false, (error && error.stack) || String(error))
      document.getElementById('report').textContent = JSON.stringify(report)
    }
  })()
</script>
</body></html>`
}

// ------------------------------------------------------------------- run it

let passed = 0
let failed = 0
// [PATCH 2026-10-19 portable-react-umd] 跳过的 section 数：跳了不等于过了。
let skipped = 0

function check(name, ok, detail) {
  if (ok === true) {
    passed += 1
    process.stdout.write(`  ok   ${name}\n`)
  } else {
    failed += 1
    process.stdout.write(`  FAIL ${name}${detail === undefined || detail === '' ? '' : ` — ${detail}`}\n`)
  }
}

function decodeEntities(value) {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

async function dumpDom(port, path) {
  const profileDir = mkdtempSync(join(tmpdir(), 'session-translator-chrome-'))
  try {
    const { stdout } = await run(
      chrome,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--mute-audio',
        '--hide-scrollbars',
        `--user-data-dir=${profileDir}`,
        '--virtual-time-budget=30000',
        '--dump-dom',
        `http://127.0.0.1:${port}${path}`,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 180000, windowsHide: true },
    )
    return stdout
  } finally {
    rmSync(profileDir, { recursive: true, force: true })
  }
}

function readReport(dom) {
  const match = /<pre id="report">([\s\S]*?)<\/pre>/.exec(dom)
  if (match === null) return null
  const raw = decodeEntities(match[1]).trim()
  if (raw === '') return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
const port = httpServer.address().port

try {
  process.stdout.write(`browser check (chrome=${chrome}, port=${port})\n`)

  process.stdout.write('inline translator\n')
  const fixtureDom = await dumpDom(port, '/fixture.html')
  const fixtureReport = readReport(fixtureDom)
  if (fixtureReport === null) {
    check('fixture produced a report', false, 'no <pre id="report"> payload found')
    process.stdout.write(fixtureDom.slice(0, 2000))
  } else {
    for (const entry of fixtureReport) check(entry.name, entry.ok, entry.detail)
  }
  check('panels exist in the serialized DOM', /data-dsh-session-translator="panel"/.test(fixtureDom))

  if (reactFile !== undefined && reactDomFile !== undefined) {
    process.stdout.write('settings section\n')
    const settingsDom = await dumpDom(port, '/settings.html')
    const settingsReport = readReport(settingsDom)
    if (settingsReport === null) {
      check('settings fixture produced a report', false, 'no <pre id="report"> payload found')
      process.stdout.write(settingsDom.slice(0, 2000))
    } else {
      for (const entry of settingsReport) check(entry.name, entry.ok, entry.detail)
    }
  } else {
    // [PATCH 2026-10-19 portable-react-umd] 原来是静默 skip，第三方机器根本
    // 不知道少测了一半。改成明确写出"跳过了什么、怎么补"，并计为跳过项。
    process.stdout.write(
      'settings section\n  SKIP no React UMD build found (settings panel NOT verified)\n' +
        '       fix: set COT_EN2CN_REACT / COT_EN2CN_REACT_DOM to the UMD files, or\n' +
        '            install react + react-dom into the DSH profile node_modules\n',
    )
    skipped += 1
  }
} finally {
  httpServer.close()
}

process.stdout.write(`\n${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}\n`)
if (skipped > 0) {
  process.stdout.write('note: skipped sections were NOT verified — do not treat this run as a full pass\n')
}
if (failed > 0) process.exitCode = 1
