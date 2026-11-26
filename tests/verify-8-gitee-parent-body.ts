// tests/verify-8-gitee-parent-body.ts —— #8 Gitee 父子关系正文兜底门禁（不联网）
//
// 测什么：
//   A) 约定本身：`上级地图：#票号` 的生成、解析、幂等替换；存量带链接写法只读兼容；
//   B) 房层：结构字段生效时以结构为准；结构字段被静默忽略时改成写正文并读回确认；
//      重复挂同一父票不再写第二行；改挂另一张地图时替换旧行；两条路都失败时如实失败；
//   C) 规则层：读回的票标着来源「正文」时，父子边判成正文行并说清来源；标着「结构」时说清来源；
//      没标来源的老后端文案逐字不变；
//   D) 工具层：带父票建票、远端结构没生效但正文兜底成功时，回执逐条证据里带着
//      「远端结构字段没生效，已写进票正文（来源：正文）」；两条路都失败时回 partial 说没挂上。
const path = require('path')
const { pathToFileURL } = require('url')
const { makeDecideStub, chooseWorkspace } = require('./lib/deck-decide-stub.js')

const ROOT = path.resolve(__dirname, '..')
let failed = false
let total = 0
const check = (ok, msg) => { total += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failed = true }
const imp = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href)

/** 一台只认 gitee 的假平台：命令不执行，交给传入的 exec 决定回什么。 */
function fakeCtx(exec) {
  return {
    cwd: '/ws/8',
    platform: { resolveExecutable: async (name) => name === 'gitee' ? 'C:\\fake\\gitee.exe' : 'C:\\fake\\node.exe' },
    exec: exec,
  }
}

/**
 * 假远端：按 gitee api 的命令行参数回答读票、建票、改票，并按开关复现「parent_id 被静默忽略」。
 * 这里不碰网络，也不假装 Gitee 的真实现状——只按本票要验证的两种远端行为作答。
 */
function makeRemote(opts) {
  const o = opts || {}
  const store = new Map()
  const calls = []
  const seed = (key, row) => store.set(key, row)
  seed('8', { id: 8008, number: '8', title: '地图八', state: 'open', body: '# 地图八', labels: [] })
  seed('9', { id: 9009, number: '9', title: '地图九', state: 'open', body: '# 地图九', labels: [] })
  // 票号不是纯数字的仓库：只有这种仓库的 parent_url 尾段才是真票号，结构字段的成功路径才可能复现。
  seed('I8MAP8', { id: 80088, number: 'I8MAP8', title: '地图八（企业票号）', state: 'open', body: '# 地图八', labels: [] })
  seed('90', { id: 900090, number: '90', title: '实施票', state: 'open', body: '原正文', labels: [] })
  const keyOfId = (id) => {
    let found = ''
    store.forEach((row, key) => { if (row.id === id) found = key })
    return found
  }
  const exec = async (cmd, args) => {
    calls.push(args.join(' '))
    const target = String(args[1] || '')
    const method = args.indexOf('--method') >= 0 ? String(args[args.indexOf('--method') + 1]) : 'GET'
    const bodyAt = args.indexOf('--body')
    const payload = bodyAt >= 0 ? JSON.parse(String(args[bodyAt + 1])) : null
    const single = /^repos\/o\/r\/issues\/([^/]+)$/.exec(target)
    if (method === 'GET' && single) {
      const row = store.get(decodeURIComponent(single[1]))
      if (!row) return { code: 1, stdout: '', stderr: '404 not found' }
      return { code: 0, stdout: JSON.stringify(row), stderr: '' }
    }
    if (method === 'POST' && target === 'repos/o/issues') {
      if (o.createFails) return { code: 1, stdout: '', stderr: '500 create refused' }
      const key = '91'
      const row = { id: 910091, number: key, title: payload.title, state: 'open', body: payload.body || '', labels: [] }
      if (payload.parent_id !== undefined && o.structureWorks) row.parent_url = 'https://gitee.com/o/r/issues/' + keyOfId(payload.parent_id)
      store.set(key, row)
      return { code: 0, stdout: JSON.stringify(row), stderr: '' }
    }
    const patch = /^repos\/o\/issues\/([^/]+)$/.exec(target)
    if (method === 'PATCH' && patch) {
      const key = decodeURIComponent(patch[1])
      const row = store.get(key)
      if (!row) return { code: 1, stdout: '', stderr: '404 not found' }
      if (payload && payload.body !== undefined) {
        if (o.bodyWriteFails) return { code: 1, stdout: '', stderr: '403 正文没有写权限' }
        row.body = String(payload.body)
      }
      if (payload && payload.parent_id !== undefined && o.structureWorks) {
        const parentKey = keyOfId(payload.parent_id)
        row.parent_url = 'https://gitee.com/o/r/issues/' + parentKey
      }
      return { code: 0, stdout: JSON.stringify(row), stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected request: ' + method + ' ' + target }
  }
  return { exec: exec, calls: calls, store: store }
}

const parentLineCount = (body) => String(body || '').split(/\r?\n/).filter((line) => line.trim().indexOf('上级地图：') === 0).length

async function main() {
  console.log('Gitee 父子关系正文兜底门禁（#8：结构字段被静默忽略时写进正文，读侧解析回来并标出来源）')

  const parentLine = await imp('src/tracker/rooms/gitee/model/parent-line.ts')
  const rules = await imp('src/deck/rules/edge-landing.ts')
  const marker = await imp('src/shared/issue-file/src/marker.ts')

  // ---- A) 约定本身 ----
  check(parentLine.parentLineText('8') === '上级地图：#8', 'A1 规范写法是一行「上级地图：#票号」，不带链接')
  const empty = parentLine.withParentLine('', '8')
  check(empty.trim() === '上级地图：#8', 'A2 空正文写出来就是这一行（不会多出空行）：' + JSON.stringify(empty))
  const twice = parentLine.withParentLine(parentLine.withParentLine('原正文', '8'), '8')
  check(parentLineCount(twice) === 1 && twice.indexOf('上级地图：#8') >= 0, 'A3 重复挂同一父票仍只有一行')
  const switched = parentLine.withParentLine('上级地图：#8\n\n原正文', '9')
  check(parentLineCount(switched) === 1 && switched.indexOf('上级地图：#9') >= 0 && switched.indexOf('#8') < 0, 'A4 改挂另一张地图时旧行被替换，不出现两行')
  const legacy = '上级地图：[地图八](https://gitee.com/o/r/issues/I8A2BC)'
  check(parentLine.parentKeyFromBody(legacy) === 'I8A2BC', 'A5 存量带链接写法读得出来（只读兼容）')
  check(parentLine.parentKeyFromBody('上级地图：[](https://gitee.com/o/r/issues/12345)') === null, 'A6 链接尾段是纯数字（远端内部 id）时不冒充票号')
  const withMarker = parentLine.withParentLine('<!-- DSH-ISSUE-KIND: spec -->\n\n# 标题', '8')
  check(marker.markerKindInHeader(withMarker) === 'spec', 'A7 类型标记仍留在开头，父票行插在它后面')
  check(withMarker.split(/\r?\n/)[1].trim() === '上级地图：#8', 'A8 父票行紧跟在开头注释之后')
  check(rules.parentLineOf(withMarker) === '8' && rules.parentLineOf(legacy) === 'I8A2BC', 'A9 纯规则层的解析与房层同结果（两份约定对齐）')

  // ---- C) 规则层判决 ----
  const bodyAfter = { issue: { parentKey: '8', parentSource: 'body', body: '上级地图：#8' } }
  const bodyEv = rules.classifyEdgeLanding('parent', '8', bodyAfter, '90')
  check(bodyEv.kind === 'body-line', 'C1 来源是正文、正文里真有那一行 → kind body-line（实得 ' + bodyEv.kind + '）')
  check(bodyEv.text.indexOf('远端结构字段没生效，已写进票正文（来源：正文）') >= 0, 'C2 证据原话带来源：' + bodyEv.text)
  check(rules.landingOf('parent', bodyEv) === rules.EDGE_LANDING.BODY_LINE, 'C3 落点标成「正文行」')
  const structEv = rules.classifyEdgeLanding('parent', '8', { issue: { parentKey: '8', parentSource: 'structure', body: '' } }, '90')
  check(structEv.kind === 'contract' && structEv.text.indexOf('（来源：结构）') >= 0, 'C4 结构字段有值时以结构为准，证据标「来源：结构」')
  const plainEv = rules.classifyEdgeLanding('parent', '8', { issue: { parentKey: '8', body: '' } }, '90')
  check(plainEv.kind === 'contract' && plainEv.text.indexOf('来源：') < 0, 'C5 没标来源的老后端文案逐字不变（不出现来源标注）')

  // ---- B) 房层：真实 write.ts / read.ts，假远端 ----
  const giteeMod = await imp('src/tracker/rooms/gitee/index.ts')
  const repo = { refId: 'o/r' }

  {
    const remote = makeRemote({ structureWorks: true })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setParent(repo, '90', 'I8MAP8', {})
    check(r.ok === true && r.data.parentKey === 'I8MAP8', 'B1 结构字段生效时挂父票成功（实得 ok=' + r.ok + '，parentKey=' + (r.data && r.data.parentKey) + '）')
    check(r.data.parentSource === 'structure', 'B2 来源标成结构（实得 ' + (r.data && r.data.parentSource) + '）')
    check(!remote.calls.some((c) => c.indexOf('上级地图：') >= 0), 'B3 结构字段已生效时不再写正文')
  }

  {
    const remote = makeRemote({ structureWorks: false })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setParent(repo, '90', '8', {})
    check(r.ok === true && r.data.parentKey === '8', 'B4 parent_id 被静默忽略时，正文兜底后仍读回父票（实得 ok=' + r.ok + '）')
    check(r.data.parentSource === 'body', 'B5 来源标成正文（实得 ' + (r.data && r.data.parentSource) + '）')
    check(parentLineCount(r.data.body) === 1 && r.data.body.indexOf('上级地图：#8') >= 0, 'B6 正文里只有一行「上级地图：#8」')
    check(remote.calls.some((c) => c.indexOf('--body') >= 0 && c.indexOf('上级地图：#8') >= 0), 'B7 正文兜底真的发了改正文请求')

    const before = remote.calls.length
    const again = await tracker.setParent(repo, '90', '8', {})
    check(again.ok === true && parentLineCount(again.data.body) === 1, 'B8 重复挂同一父票仍只有一行')
    check(!remote.calls.slice(before).some((c) => c.indexOf('上级地图：') >= 0), 'B9 重复挂时不再写第二遍正文')

    const moved = await tracker.setParent(repo, '90', '9', {})
    check(moved.ok === true && moved.data.parentKey === '9', 'B10 改挂另一张地图后读回新父票（实得 ' + (moved.data && moved.data.parentKey) + '）')
    check(parentLineCount(moved.data.body) === 1 && moved.data.body.indexOf('上级地图：#9') >= 0 && moved.data.body.indexOf('#8') < 0, 'B11 正文里旧行被替换，不出现两行')

    const readBack = await tracker.get(repo, '90', {})
    check(readBack.ok === true && readBack.data.parentKey === '9' && readBack.data.parentSource === 'body', 'B12 重开这张票读回上级与来源标注正确（来源：正文）')
  }

  {
    const remote = makeRemote({ structureWorks: false })
    remote.store.get('90').body = legacy
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.get(repo, '90', {})
    check(r.ok === true && r.data.parentKey === 'I8A2BC' && r.data.parentSource === 'body', 'B13 存量带链接写法仍能读出上级')
  }

  {
    const remote = makeRemote({ structureWorks: false, bodyWriteFails: true })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setParent(repo, '90', '8', {})
    check(r.ok === false, 'B14 结构与正文都没写成时如实失败（实得 ok=' + r.ok + '）')
    const msg = String((r.error && r.error.message) || '')
    check(msg.indexOf('结构字段没生效') >= 0 && msg.indexOf('没读回来') >= 0, 'B15 失败原话写清两条路都没成：' + msg.slice(0, 140))
  }

  {
    const remote = makeRemote({ structureWorks: false })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.create(repo, { title: '带父票的新票', body: '正文', parentKey: '8' })
    check(r.ok === true && r.data.parentKey === '8' && r.data.parentSource === 'body', 'B16 建票时 parent_id 被忽略 → 正文兜底并读回父票（实得 ' + (r.data && r.data.parentKey) + '/' + (r.data && r.data.parentSource) + '）')
    check(parentLineCount(r.data.body) === 1, 'B17 建票兜底后正文仍只有一行父票行')
  }

  {
    const remote = makeRemote({ structureWorks: false, bodyWriteFails: true })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.create(repo, { title: '两条路都不通的票', body: '正文', parentKey: '8' })
    const note = r.data && r.data.parentError
    check(r.ok === true && note && String(note.message || '').indexOf('结构字段没生效') >= 0, 'B18 建票时两条路都失败：票仍建成，但票上记着父子边没挂上（parentError）')
  }

  // ---- D) 工具层：回执里看得见来源 ----
  {
    const budget = await imp('src/refresh/kernel/host-budget.js')
    const ledgerMod = await imp('src/refresh/rooms/host/quota-ledger.ts')
    const gateMod = await imp('src/refresh/rooms/host/refresh-gate.ts')
    const registryMod = await imp('src/tracker/registry/core.ts')
    const toolCost = await imp('src/refresh/kernel/tool-call-budget.js')
    const createMod = await imp('src/deck/tools/issue-create.ts')
    const clock = 1700000000000
    const ledger = ledgerMod.createLedger({ now: () => clock })
    const gate = gateMod.createGate({ ledger: ledger, now: () => clock })
    ledger.ensureBackend('github', { kind: 'two-buckets' })
    ledger.syncServer('github', { rest: { limit: 5000, remaining: 5000, reset: clock + 3600000 }, graphql: { limit: 5000, remaining: 5000, reset: clock + 3600000 } }, clock)
    const registry = registryMod.createRegistry({ logEvent: () => {}, isEnabled: () => false }, { matchesTimeout: 200 })
    const mapRow = { key: '8', title: '地图八', state: 'open', type: 'map', body: '', labels: [], assignees: [], parentKey: null }
    const stubBody = {
      id: 'stub-8-body', label: '桩（结构没生效、正文兜底成功）', matches: async () => false,
      budget: { kind: 'off-network', countsRequests: false, countsPoints: false, independentBuckets: false },
      create: () => ({
        id: 'stub-8-body',
        async create(repoArg, input) {
          return { ok: true, data: { key: '90', title: input.title, state: 'open', body: '上级地图：#8', labels: [], assignees: [], parentKey: '8', parentSource: 'body' } }
        },
        async get(repoArg, key) {
          if (String(key) === '8') return { ok: true, data: mapRow }
          return { ok: true, data: { key: String(key), title: 't', state: 'open', body: '上级地图：#8', labels: [], assignees: [], parentKey: '8', parentSource: 'body' } }
        },
      }),
    }
    const disp = registry.register(stubBody)
    const handle = { cwd: '/ws/8', refId: 'o/r' }
    chooseWorkspace('/ws/8', 'stub-8-body')
    const deps = {
      gate, registry, budget, estimate: toolCost.estimateToolCost, costInputFrom: toolCost.toolCostInputFrom,
      handleFor: () => handle, backendCtx: {}, now: () => clock, log: { fire: () => {} }, invalidate: () => {},
      decideBackend: makeDecideStub(registry),
    }
    const createTool = createMod.createDeckIssueCreate(deps)
    const exec = { agent: { session: { id: 's-8', cwd: '/ws/8' } } }
    const cr = await createTool.run(exec, { title: '带父票的新票', kind: 'issue', parentKey: '8' })
    const citem = (cr.items || [])[0] || {}
    check(cr.status === 'ok', 'D1 正文兜底成功时工具层按挂上回报（实得 ' + cr.status + '）')
    check(String(citem.evidence || '').indexOf('远端结构字段没生效，已写进票正文（来源：正文）') >= 0, 'D2 回执逐条证据里带着来源原话：' + String(citem.evidence || '').slice(0, 160))

    const stubNone = {
      id: 'stub-8-none', label: '桩（结构没生效、正文也没写成）', matches: async () => false,
      budget: { kind: 'off-network', countsRequests: false, countsPoints: false, independentBuckets: false },
      create: () => ({
        id: 'stub-8-none',
        async create(repoArg, input) {
          return { ok: true, data: { key: '92', title: input.title, state: 'open', body: '', labels: [], assignees: [], parentKey: null, parentError: { kind: 'write', message: '远端结构字段没生效，写进票正文也没读回来（来源：正文）：正文没有写权限' } } }
        },
        async get(repoArg, key) {
          if (String(key) === '8') return { ok: true, data: mapRow }
          return { ok: true, data: { key: String(key), title: 't', state: 'open', body: '', labels: [], assignees: [], parentKey: null } }
        },
      }),
    }
    const disp2 = registry.register(stubNone)
    chooseWorkspace('/ws/8', 'stub-8-none')
    const createTool2 = createMod.createDeckIssueCreate(deps)
    const bad = await createTool2.run(exec, { title: '两条路都不通的票', kind: 'issue', parentKey: '8' })
    check(bad.status === 'partial' && String(bad.text || '').indexOf('没挂上') >= 0, 'D3 两条路都失败时如实报 partial 与「没挂上」：' + String(bad.text || '').slice(0, 140))
    check(String(bad.text || '').indexOf('结构字段没生效') >= 0, 'D4 失败回执里带着房的原话（两条路都没成）')
    disp.dispose()
    disp2.dispose()
  }

  console.log(failed ? ('门禁失败：' + total + ' 条断言里有失败') : ('门禁通过：' + total + ' 条断言全绿'))
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('门禁执行异常：' + ((e && e.stack) || e)); process.exit(1) })
