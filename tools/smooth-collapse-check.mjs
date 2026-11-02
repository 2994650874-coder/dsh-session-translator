/**
 * 第三形态验证：正文**仍挂在 DOM**、只被 CSS 压掉（dsh-smooth-stream 的折叠态）。
 *
 * 与同目录 fold-mode-check.mjs 的区别（别合并）：
 *   - 官方 ReasoningRow 折叠 = 正文**卸载** → 只能沿 fiber props 取文
 *   - smooth-stream 折叠 = 正文**留在 DOM**，靠 grid-template-rows:0fr +
 *     visibility:hidden 压掉（上游 AnimatedDisclosure 的 .disclosureContent）
 * 取文路径不同。若插件把"看不见"当成"没内容"，只会翻到那行预览，
 * 而失败是**静默的**（预览短于 MIN_CHARS 就直接 return null，不报错）。
 * 这条形态值得单独守：smooth-stream 关掉 thinkAutoExpand 后，
 * 每个思考块都常驻这个形态。
 *
 * 下面保留原始说明（官方 ReasoningRow 的卸载形态）：
 *
 * Fold-mode browser check: does the inline translator work when
 * `foldOriginal: true`?
 *
 * Why this file exists: browser-check.mjs has ZERO coverage of fold mode
 * (`foldOriginal` appears 0 times in it). Fold mode is the *default* the user
 * runs, and it takes a completely different path:
 *
 *   - a folded ReasoningRow unmounts its body, so `findReasoningBody()` finds
 *     nothing and the source text must come from the React fiber props
 *     (`rawRowText` → `__reactFiber$` → `memoizedProps.text`)
 *   - if that fiber read fails, `rowSourceText()` silently falls back to the
 *     rendered DOM text, which for a folded row is only the one-line summary
 *   - a one-line summary is shorter than MIN_CHARS (12), so `syncRow()` returns
 *     null and **nothing is ever translated, with no error anywhere**
 *
 * That silent failure is exactly the reported symptom ("automatic translation
 * stopped working"), so this test renders real React (not hand-written HTML) to
 * reproduce the fiber layout DSH actually produces.
 *
 * Run: node tools/fold-mode-check.mjs [--chrome <path>]
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
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
  'D:\\百分\\CentBrowser\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter((v) => typeof v === 'string' && v !== '')

const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate))
if (chrome === undefined) {
  process.stdout.write('no Chrome/Edge found; skipping the smooth-collapse check\n')
  process.exit(0)
}

// ---------------------------------------------------------------- React UMD
const REASONING = 'Let me check the manifest first. The loader reads dsh.profile.bundles from the manifest, and a missing name makes the patch silently never apply. That is the bug the user is hitting right now.'

const profileNm = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop', 'node_modules')

/** React UMD builds left behind by an earlier browser-check run. */
function cachedReactPairs() {
  const out = []
  let entries
  try { entries = readdirSync(tmpdir()) } catch { return out }
  for (const name of entries) {
    if (!/^session-translator-react-/.test(name) && !/^react-/.test(name)) continue
    const dir = join(tmpdir(), name)
    for (const [file, dom] of [
      ['react.development.js', 'react-dom.development.js'],
      ['react.production.min.js', 'react-dom.production.min.js'],
    ]) {
      const reactPath = join(dir, file)
      const domPath = join(dir, dom)
      try {
        if (existsSync(reactPath) && existsSync(domPath) && readFileSync(reactPath).length > 1000) {
          out.push({ react: reactPath, reactDom: domPath })
        }
      } catch { /* unreadable cache entry */ }
    }
  }
  return out
}

const cached = cachedReactPairs()[0]
const REACT_CANDIDATES = [
  ...(process.env.COT_EN2CN_REACT ? [process.env.COT_EN2CN_REACT] : []),
  join(profileNm, 'react', 'umd', 'react.development.js'),
  join(profileNm, 'react', 'umd', 'react.production.min.js'),
  ...(cached === undefined ? [] : [cached.react]),
]
const REACT_DOM_CANDIDATES = [
  ...(process.env.COT_EN2CN_REACT_DOM ? [process.env.COT_EN2CN_REACT_DOM] : []),
  join(profileNm, 'react-dom', 'umd', 'react-dom.development.js'),
  join(profileNm, 'react-dom', 'umd', 'react-dom.production.min.js'),
  ...(cached === undefined ? [] : [cached.reactDom]),
]

const reactFile = REACT_CANDIDATES.find((candidate) => existsSync(candidate))
const reactDomFile = REACT_DOM_CANDIDATES.find((candidate) => existsSync(candidate))
if (reactFile === undefined || reactDomFile === undefined) {
  process.stdout.write('no React UMD build found; skipping the smooth-collapse check\n')
  process.exit(0)
}

// ------------------------------------------------------------------- fixture
// Mirrors DSH's ReasoningRow: a memo component whose props carry
// `{ text, running }`, rendering a root div with data-variant="think", and
// unmounting the body while collapsed (exactly what the real component does).
function fixtureHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>fold-mode fixture</title>
<style>
  body { font-family: sans-serif; margin: 0; padding: 16px; }
  .r_root { display: flex; flex-direction: column; }
  .r_row { height: 24px; }
  /* ↓↓↓ 抄 dsh-smooth-stream 的真实配方：折叠靠 grid-template-rows:0fr +
     visibility:hidden，正文节点**不卸载**。 */
  .sc_content { display: grid; overflow: hidden; grid-template-rows: 1fr; }
  .sc_content[data-collapsed] { visibility: hidden; grid-template-rows: 0fr; }
  .sc_content > * { min-height: 0; }
  .sc_content[data-collapsed] > * { overflow: hidden; }
  .r_thinkBody { white-space: pre-wrap; padding: 4px 0 4px 22px; }
</style>
</head>
<body>
<div id="app"></div>
<script src="/react.js"></script>
<script src="/react-dom.js"></script>
<script>
  const h = React.createElement
  // 与上游 AnimatedReasoning 同形：memo + { text, running } props。
  // 差别只在折叠方式——**不卸载**正文，用 .sc_content[data-collapsed] 压掉。
  const ReasoningRow = React.memo(function ReasoningRow({ text, running, expanded }) {
    const summary = running ? text.slice(0, 40) : text.split('.')[0] + '.'
    return h('div', {
      className: 'r_root',
      'data-variant': 'think',
      'data-state': running ? 'running' : 'ok',
      'data-expanded': expanded || undefined,
    },
      h('div', { className: 'r_row' }, h('span', { className: 'r_title' }, '思考'),
        h('span', { className: 'r_summary' }, summary)),
      h('div', {
        className: 'sc_content',
        'data-disclosure-content': true,
        'data-collapsed': expanded ? undefined : '',
      }, h('div', { className: 'r_thinkBody' }, text)),
    )
  })

  // 只放 CSS 折叠行。理由同 fold-mode-check：展开行会自己产出全文，
  // 掩盖折叠行的取文是否成功。
  window.__ROWS = [
    { id: 'row-folded', text: ${JSON.stringify(REASONING)}, running: false, expanded: false },
  ]

  function App() {
    return h('div', null, window.__ROWS.map((row) =>
      h('div', { key: row.id, id: row.id },
        h(ReasoningRow, { text: row.text, running: row.running, expanded: row.expanded }),
      ),
    ))
  }
  ReactDOM.createRoot(document.getElementById('app')).render(h(App))
</script>
<script>
  // client.js is a module-loader bundle: it calls window.__ModuleLoader__.load
  // at execution time, exactly like every DSH client plugin. Provide the stub
  // first (browser-check.mjs does the same).
  window.__report = []
  function log(name, ok, detail) {
    window.__report.push({ name: name, ok: ok === true, detail: detail === undefined ? '' : String(detail) })
  }
  window.onerror = function (message) { log('window.onerror', false, message) }
  window.addEventListener('unhandledrejection', function (event) {
    log('unhandledrejection', false, String(event.reason))
  })
  window.__ModuleLoader__ = { load: function (record) { window.__pluginRecord = record } }
</script>
<script src="/client.js"></script>
<script>
  ;(async function () {
    try {
      var record = window.__pluginRecord
      log('bundle registered', record !== undefined && record.id === 'dsh-session-translator', record && record.id)
      if (record === undefined) { document.title = 'NO_BUNDLE'; return }
      var plugin = record.factory(function (name) {
        if (name === 'react') return React
        throw new Error('unexpected require: ' + name)
      })
      log('apply exported', typeof plugin.apply === 'function')

      var slots = {
        inject: function (name, callback) { callback() },
        register: function () { return function () {} },
      }
      var locale = {
        register: function () { return function () {} },
        bind: function () { return function (key) { return key } },
        subscribe: function () { return function () {} },
      }
      // Drive apply() exactly as the DSH client loader does: a ctx with get()
      // and a real ctx.effect that keeps the disposer.
      var disposers = []
      plugin.apply({
        get: function (name) {
          if (name === 'slots') return slots
          if (name === 'locale') return locale
          return undefined
        },
        effect: function (factory) {
          var disposer = factory()
          if (typeof disposer === 'function') disposers.push(disposer)
          return disposer
        },
      })
      window.__disposers = disposers

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

      function panels() {
        return document.querySelectorAll('[data-dsh-session-translator="panel"]')
      }
      var anyPanel = await waitFor(function () { return panels().length > 0 }, 12000)
      log('a panel was created for the CSS-collapsed row', anyPanel !== null, panels().length)

      // fixture 形态自检：证明它真的是"CSS 折叠"而不是"卸载"。
      // 正文节点必须还在 DOM 里，且真的被压成不可见。
      // 少了这两条，fixture 就退化成 fold-mode-check 的翻版，测的不是这个形态。
      //
      // 必须放在 waitFor 之后：createRoot().render() 是异步调度，同步阶段
      // DOM 还是空的，那时取样只会拿到 'no node'。
      var collapsed = document.querySelector('#row-folded .sc_content')
      var collapsedBody = collapsed === null ? null : collapsed.querySelector('.r_thinkBody')
      log('the collapsed row keeps its body mounted', collapsedBody !== null,
        collapsedBody === null ? 'unmounted' : String(collapsedBody.textContent.length) + ' chars kept')
      log('the collapsed row is visually suppressed by CSS',
        collapsed !== null && collapsed.hasAttribute('data-collapsed') &&
          getComputedStyle(collapsed).visibility === 'hidden',
        collapsed === null ? 'no node' : getComputedStyle(collapsed).visibility)

      // 到底走了哪条取文路径？fold 模式与 inline 模式是两套代码。
      // 不加这条，测试可能在 inline 模式下全绿，却完全没验证 fold 路径。
      var firstPanel = panels().length > 0 ? panels()[0] : null
      log('the panel was built in fold mode (not inline)', firstPanel !== null && firstPanel.dataset.mode === 'fold',
        firstPanel === null ? 'no panel' : String(firstPanel.dataset.mode))

      var translated = await waitFor(function () {
        return Array.prototype.filter.call(panels(), function (panel) {
          return panel.textContent.indexOf('【译】') !== -1
        })
      }, 12000)
      log('a translation is rendered', translated !== null)
    } catch (error) {
      log('script threw', false, error && error.message ? error.message : String(error))
    } finally {
      // --dump-dom gives us the DOM, so surface the report as an element.
      var pre = document.createElement('pre')
      pre.id = 'report'
      pre.textContent = JSON.stringify(window.__report)
      document.body.appendChild(pre)
      document.title = 'DONE'
    }
  })()
</script>
</body></html>`
}

// -------------------------------------------------------------------- server
let translateCalls = 0
const seen = []
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')

  if (url.pathname === '/react.js') { res.setHeader('content-type', 'application/javascript'); res.end(readFileSync(reactFile)); return }
  if (url.pathname === '/react-dom.js') { res.setHeader('content-type', 'application/javascript'); res.end(readFileSync(reactDomFile)); return }
  if (url.pathname === '/client.js') { res.setHeader('content-type', 'application/javascript'); res.end(readFileSync(join(root, 'lib', 'client.js'))); return }
  if (url.pathname === '/fixture.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(fixtureHtml()); return }

  if (url.pathname === '/dsh-session-translator/state') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({
      ok: true,
      version: 'test',
      config: {
        enabled: true,
        autoTranslate: true,
        liveTranslate: false,
        targetLanguage: 'zh-CN',
        provider: 'test',
        model: 'test',
        disableThinking: true,
        maxChunkChars: 2400,
        maxInputChars: 50000,
        timeoutMs: 600000,
        concurrency: 2,
        cacheEntries: 600,
        skipMostlyChinese: true,
        // The whole point: fold mode ON, exactly like the user's config.
        foldOriginal: true,
        translateErrors: false,
        fontSizePx: 15,
        horizonRows: 5,
        fallbackProvider: 'bing',
        fallbackModel: 'bing-translate',
        fallbackIdleMs: 5000,
        fallbackChunkChars: 10000,
      },
      stats: {},
      languages: [{ id: 'zh-CN', name: '简体中文' }],
    }))
    return
  }

  if (url.pathname === '/dsh-session-translator/translate') {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      translateCalls += 1
      let text = ''
      try { text = JSON.parse(body).text ?? '' } catch { /* ignore */ }
      seen.push(text)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({
        ok: true,
        translation: `【译】${text.slice(0, 30)}`,
        skipped: null,
        chunks: 1,
        failedChunks: 0,
        cached: false,
        route: { provider: 'test', model: 'test' },
        ms: 5,
      }))
    })
    return
  }

  if (url.pathname === '/dsh-session-translator/catalog') {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ ok: true, providers: [] }))
    return
  }

  res.statusCode = 404
  res.end('{}')
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port

// --------------------------------------------------------------------- drive
const userDataDir = mkdtempSync(join(tmpdir(), 'fold-mode-chrome-'))
let passed = 0
let failed = 0
const failures = []
function ok(name, cond, extra) {
  if (cond) { passed += 1; process.stdout.write(`  ok   ${name}\n`) }
  else { failed += 1; failures.push(name); process.stdout.write(`  FAIL ${name}${extra ? ' :: ' + extra : ''}\n`) }
}

try {
  process.stdout.write(`smooth-collapse check (chrome=${chrome}, port=${port})\n`)

  const { stdout } = await run(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    '--virtual-time-budget=9000',
    '--dump-dom',
    `http://127.0.0.1:${port}/fixture.html`,
  ], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 })

  const dom = stdout

  // The fixture reports through window.__report; --dump-dom only gives us the
  // DOM, so read the assertions back from the serialized report element.
  const reportMatch = dom.match(/<pre id="report">([\s\S]*?)<\/pre>/)
  let report = []
  if (reportMatch !== null) {
    try {
      report = JSON.parse(reportMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    } catch { report = [] }
  }
  const entry = (name) => report.find((row) => row.name === name)
  const reported = (name) => entry(name)?.ok === true

  ok('the fixture rendered real React rows', dom.includes('data-variant="think"'))
  ok('the client bundle registered itself', reported('bundle registered'), JSON.stringify(entry('bundle registered') ?? null))
  ok('apply() is exported', reported('apply exported'))

  // The folded row must still get a translation panel: that is the whole point
  // of fold mode (the row body is unmounted, so the text can only come from
  // the React fiber props).
  const foldedPanels = (dom.match(/data-dsh-session-translator="panel"/g) ?? []).length
  ok('a panel was created for the CSS-collapsed row', foldedPanels > 0, `panels=${foldedPanels}`)

  // fixture 形态自检：这两条要是红的，说明 fixture 没在测 CSS 折叠态
  ok('the fixture keeps the collapsed body mounted (CSS, not unmount)',
    reported('the collapsed row keeps its body mounted'),
    JSON.stringify(entry('the collapsed row keeps its body mounted') ?? null))
  ok('the fixture really suppresses the collapsed body with CSS',
    reported('the collapsed row is visually suppressed by CSS'),
    JSON.stringify(entry('the collapsed row is visually suppressed by CSS') ?? null))

  ok('the panel was built in fold mode, not inline',
    reported('the panel was built in fold mode (not inline)'),
    JSON.stringify(entry('the panel was built in fold mode (not inline)') ?? null))

  ok('the translator actually called /translate', translateCalls > 0, `calls=${translateCalls}`)

  // The source text must be the FULL reasoning text, not the one-line summary.
  // If the fiber read fails, the plugin falls back to the DOM summary and the
  // request either never happens or carries a truncated line.
  const longest = seen.reduce((best, text) => (text.length > best.length ? text : best), '')
  ok('the source text is the full reasoning text, not the folded summary',
     longest.length >= REASONING.length - 40,
     `sent ${longest.length} of ${REASONING.length} chars`)

  ok('a translation is rendered in the DOM', dom.includes('【译】'))
  ok('the page finished without a script error', !reported('script threw'), JSON.stringify(entry('script threw') ?? null))

  if (process.env.FOLD_DEBUG === '1') {
    process.stdout.write('--- report ---\n')
    process.stdout.write(reportMatch === null ? '(no report element)\n' : reportMatch[1] + '\n')
    const title = dom.match(/<title>([^<]*)<\/title>/)
    process.stdout.write(`--- title: ${title === null ? '(none)' : title[1]} ---\n`)
  }
} finally {
  server.close()
  try { rmSync(userDataDir, { recursive: true, force: true }) } catch { /* ignore */ }
}

process.stdout.write(`\nsmooth-collapse-check: ${passed} passed, ${failed} failed${failed > 0 ? '  -> ' + failures.join(', ') : ''}\n`)
process.exit(failed > 0 ? 1 : 0)
