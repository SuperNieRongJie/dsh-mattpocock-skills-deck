/**
 * tests/verify-11-gitee-blockedby-body.ts —— 票 #11：Gitee 阻塞关系走正文兜底
 *
 * 守六件事：
 *   1. 正文末尾「## Blocked by」小节的写法与读法（含存量带链接写法）是同一份约定；
 *   2. 房层读票读得出被阻塞关系并标来源「正文」，反向「阻塞了谁」扫全仓、扫不全时如实说不全；
 *   3. 房层写阻塞关系写进正文并写后读回核对，自阻塞/成环/写失败都如实失败、不落半截；
 *   4. 读票回执与边落点规则按来源标「正文行」；
 *   5. 地图「只看可接」按 blockedBy 排除被阻塞的工单，阻塞票关掉后回到可接；
 *   6. 没标来源的老后端，落点文案逐字不变（GitHub 的判据不动）。
 */
const path = require('path')
const { pathToFileURL } = require('url')
const { makeDecideStub, chooseWorkspace } = require('./lib/deck-decide-stub.js')

const ROOT = path.resolve(__dirname, '..')
let failed = false
let total = 0
const check = (ok: boolean, msg: string): void => { total += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failed = true }
const imp = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href)

function fakeCtx(exec: any) {
  return {
    cwd: '/ws/11',
    platform: { resolveExecutable: async (name: string) => (name === 'gitee' ? 'C:\\fake\\gitee.exe' : 'C:\\fake\\node.exe') },
    exec: exec,
  }
}

function seedRow(key: string, title: string, body: string, state?: string) {
  return { id: Number(key) * 10 + 1, number: key, title: title, state: state || 'open', body: body, labels: [], assignee: null }
}

function makeRemote(opts: any) {
  const o = opts || {}
  const store = new Map()
  store.set('90', seedRow('90', '实施票九十', '原正文'))
  store.set('8', seedRow('8', '阻塞票八', '地图八的正文'))
  store.set('9', seedRow('9', '阻塞票九', '', 'closed'))
  store.set('91', seedRow('91', '下游票九十一', '## Blocked by\n- 实施票九十（#90）'))
  const calls: string[] = []
  const reads = new Map<string, number>()
  const writeCalls: string[] = []
  function exec(cmd: string, args: string[]) {
    calls.push([cmd].concat(args).join(' '))
    const target = String(args[1] || '')
    const mi = args.indexOf('--method')
    const method = mi >= 0 ? String(args[mi + 1] || '').toUpperCase() : 'GET'
    const bi = args.indexOf('--body')
    const payload = bi >= 0 ? JSON.parse(String(args[bi + 1] || '{}')) : {}
    const list = /^repos\/o\/(?:r\/)?issues(\?|$)/.exec(target)
    if (method === 'GET' && list) {
      if (o.listFails) return { code: 1, stdout: '', stderr: '500 列票失败' }
      const q = target.indexOf('?') >= 0 ? target.slice(target.indexOf('?')) : ''
      const state = /[?&]state=([^&]*)/.exec(q)
      const want = state ? decodeURIComponent(state[1]) : ''
      const rows = Array.from(store.values()).filter((row: any) => !want || String(row.state) === want)
      return { code: 0, stdout: JSON.stringify(rows), stderr: '' }
    }
    const single = /^repos\/o\/r\/issues\/([^/?]+)$/.exec(target)
    if (method === 'GET' && single) {
      const key = decodeURIComponent(single[1])
      const n = (reads.get(key) || 0) + 1
      reads.set(key, n)
      if (o.readBackFails && o.readBackFails(key, n)) return { code: 1, stdout: '', stderr: '500 单票读回失败' }
      const row = store.get(key)
      if (!row) return { code: 1, stdout: '', stderr: '404 not found' }
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
        writeCalls.push('body:' + key)
      }
      if (payload && payload.parent_id !== undefined) row.parent_url = 'https://gitee.com/o/r/issues/' + String(payload.parent_id)
      return { code: 0, stdout: JSON.stringify(row), stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected request: ' + method + ' ' + target }
  }
  return { exec: exec, calls: calls, store: store, writeCalls: writeCalls, opts: o }
}

const sectionHeadingCount = (body: string): number => String(body || '').split(/\r?\n/).filter((line) => /^##\s+Blocked by\s*$/.test(line.trim())).length
const sectionLines = (body: string): string[] => {
  const lines = String(body || '').split(/\r?\n/)
  const out: string[] = []
  let inSection = false
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line.trim())) { inSection = /^##\s+Blocked by\s*$/.test(line.trim()); continue }
    if (inSection && line.trim().indexOf('- ') === 0) out.push(line.trim())
  }
  return out
}

async function main() {
  console.log('Gitee 阻塞关系正文兜底门禁（#11：正文末尾小节、来源标注、写后读回、只看可接）')

  const section = await imp('src/tracker/rooms/gitee/model/blocked-by-section.ts')
  const rules = await imp('src/deck/rules/edge-landing.ts')
  const normalizeMod = await imp('src/tracker/rooms/gitee/model/normalize.ts')

  // ---- A) 约定本身 ----
  check(section.BLOCKED_BY_HEADING === '## Blocked by', 'A1 小节标题固定是「## Blocked by」（实得 ' + section.BLOCKED_BY_HEADING + '）')
  const written = section.withBlockedBySection('', [{ key: '8', title: '地图八' }])
  check(written === '## Blocked by\n- 地图八（#8）', 'A2 空正文写出来就是标题加一条「- 标题（#票号）」（实得 ' + JSON.stringify(written) + '）')
  const twice = section.withBlockedBySection('原正文', [{ key: '8', title: '地图八' }, { key: '8', title: '地图八' }])
  check(sectionLines(twice).length === 1 && twice.indexOf('原正文') >= 0, 'A3 重复写同一张票只有一条，原正文仍在')
  const replaced = section.withBlockedBySection('原正文\n\n## Blocked by\n- 旧票（#7）\n\n## 进度\n- 说明', [{ key: '8', title: '地图八' }])
  check(sectionHeadingCount(replaced) === 1 && replaced.indexOf('#7') < 0 && replaced.indexOf('## 进度') >= 0, 'A4 重写时旧小节整段替换、后面的小节原样保留')
  const legacy = section.blockedByEntriesFromBody('## Blocked by\n- [地图八](https://gitee.com/o/r/issues/I8A2BC)')
  check(legacy.length === 1 && legacy[0].key === 'I8A2BC' && legacy[0].title === '地图八', 'A5 存量带链接写法读得出票号与标题（只读兼容）')
  check(section.blockedByEntriesFromBody('## Blocked by\n- [老票](https://gitee.com/o/r/issues/12345)').length === 0, 'A6 链接尾段是纯数字（远端内部 id）时不冒充票号')
  const stopped = section.blockedByKeysFromBody('## Blocked by\n- 八（#8）\n\n## 进度\n- 九（#9）')
  check(stopped.length === 1 && stopped[0] === '8', 'A7 小节到下一个标题就结束，后面小节里的条目不算（实得 ' + JSON.stringify(stopped) + '）')
  check(section.withBlockedBySection('原正文\n\n## Blocked by\n- 八（#8）', []).indexOf('Blocked by') < 0, 'A8 传空清单就是拆掉整段小节')
  const multiline = section.withBlockedBySection('', [{ key: '8', title: '标题里有\n换行' }])
  check(multiline.split(/\r?\n/).length === 2, 'A9 标题里的换行被压成一行，不会把小节撑断（实得 ' + JSON.stringify(multiline) + '）')
  const alignBody = '原正文\n\n## Blocked by\n- 地图八（#I8A2BC）\n- #77\n\n## 进度\n- 不算（#99）'
  check(JSON.stringify(rules.blockedBySectionKeysOf(alignBody)) === JSON.stringify(section.blockedByKeysFromBody(alignBody)), 'A10 规则层与房层对同一段正文解出同一批票号（两份约定对齐）')
  const normalized = normalizeMod.normalizeIssue({ number: '90', title: '实施票九十', body: '原正文\n\n## Blocked by\n- 地图八（#8）' })
  check(normalized.blockedBy.length === 1 && normalized.blockedBy[0].key === '8' && normalized.blockedBy[0].title === '地图八', 'A11 归一票时正文小节折进契约的 blockedBy')
  check(normalized.blockedBySource === 'body', 'A12 读到了才标来源「正文」（实得 ' + normalized.blockedBySource + '）')
  check(normalizeMod.normalizeIssue({ number: '90', title: 't', body: '原正文' }).blockedBySource === undefined, 'A13 小节是空的就不标来源，别让上层误读成「有阻塞读不出来」')

  // ---- B) 房层读 ----
  const giteeMod = await imp('src/tracker/rooms/gitee/index.ts')
  const repo = { refId: 'o/r' }
  {
    const remote = makeRemote({})
    remote.store.get('90').body = '原正文\n\n## Blocked by\n- 地图八（#8）\n- 阻塞票九（#9）'
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const got = await tracker.get(repo, '90', {})
    check(got.ok === true && got.data.blockedBy.length === 2, 'B1 打开一张票列出被谁阻塞（实得 ' + (got.data && got.data.blockedBy && got.data.blockedBy.length) + ' 条）')
    check(got.ok === true && got.data.blockedBySource === 'body', 'B2 读票结果标明来源是正文（实得 ' + (got.data && got.data.blockedBySource) + '）')
    const deps = await tracker.getDependencies(repo, '90', {})
    check(deps.ok === true && deps.data.blockedBy.map((r: any) => r.key).join(',') === '8,9', 'B3 依赖读回两张阻塞票（实得 ' + JSON.stringify(deps.ok && deps.data.blockedBy.map((r: any) => r.key)) + '）')
    const byKey: any = {}
    if (deps.ok) for (const r of deps.data.blockedBy) byKey[r.key] = r
    check(byKey['8'] && byKey['8'].title === '阻塞票八' && byKey['8'].state === 'open', 'B4 阻塞票的标题与状态从远端落实')
    check(byKey['9'] && byKey['9'].state === 'closed', 'B5 已关闭的阻塞票也如实带上关闭状态')
    check(deps.ok === true && deps.data.blocking.length === 1 && deps.data.blocking[0].key === '91', 'B6 反向列出「阻塞了谁」（实得 ' + JSON.stringify(deps.ok && deps.data.blocking.map((r: any) => r.key)) + '）')
    check(deps.ok === true && deps.data.blockingSource === 'scan' && deps.data.blockingComplete === true, 'B7 反向关系标明是扫票面扫出来的、这一趟扫全了')
  }
  {
    const remote = makeRemote({ readBackFails: (key: string) => key === '90' })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const deps = await tracker.getDependencies(repo, '90', {})
    const msg = String((deps.error && deps.error.message) || '')
    check(deps.ok === false && msg.indexOf('读不回') < 0, 'B8 单票读不回来时整体失败（原话：' + msg.slice(0, 80) + '）')
  }
  {
    const remote = makeRemote({ listFails: true })
    remote.store.get('90').body = '## Blocked by\n- 阻塞票八（#8）'
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const deps = await tracker.getDependencies(repo, '90', {})
    check(deps.ok === true && deps.data.blockedBy.length === 1 && deps.data.blockedBy[0].title === '阻塞票八', 'B9 列全仓票面失败时，被阻塞关系仍逐张读回来（不因反向扫不动就丢掉被阻塞）')
    check(deps.ok === true && deps.data.blockingComplete === false && String(deps.data.blockingNote || '').length > 0, 'B10 反向扫不动时如实标「不全」并写明原因（实得 ' + String(deps.ok && deps.data.blockingNote).slice(0, 60) + '）')
  }

  // ---- C) 房层写 ----
  {
    const remote = makeRemote({})
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setBlockedBy(repo, '90', ['8', '9'], {})
    check(r.ok === true && r.data.blockedBy.length === 2, 'C1 标记被两张票阻塞后读回两条（实得 ok=' + r.ok + '）')
    check(r.data && sectionHeadingCount(r.data.body) === 1 && sectionLines(r.data.body).length === 2, 'C2 正文末尾只有一个「## Blocked by」小节、里面两条')
    check(r.data && r.data.body.indexOf('- 阻塞票八（#8）') >= 0 && r.data.body.indexOf('- 阻塞票九（#9）') >= 0, 'C3 条目写成「- 标题（#票号）」')
    check(r.data && r.data.blockedBySource === 'body', 'C4 写回的结果也标明来源是正文')
    const writes = remote.writeCalls.length
    const again = await tracker.setBlockedBy(repo, '90', ['8', '9'], {})
    check(again.ok === true && sectionLines(again.data.body).length === 2, 'C5 重复标记同一批票不会出现第二条')
    check(remote.writeCalls.length === writes, 'C6 重复标记时不再发第二次改正文请求（实得 ' + (remote.writeCalls.length - writes) + ' 次）')
    const one = await tracker.setBlockedBy(repo, '90', ['9'], {})
    check(one.ok === true && sectionLines(one.data.body).length === 1 && one.data.body.indexOf('#8') < 0, 'C7 改成只被一张票阻塞时小节整段替换')
    const cleared = await tracker.setBlockedBy(repo, '90', [], {})
    check(cleared.ok === true && sectionHeadingCount(cleared.data.body) === 0, 'C8 传空清单就拆掉小节（取消全部阻塞）')
    check(cleared.data && cleared.data.body.indexOf('原正文') >= 0, 'C9 改关系时票面原有正文一个字都没丢')
  }
  {
    const remote = makeRemote({})
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const before = remote.calls.length
    const r = await tracker.setBlockedBy(repo, '90', ['90'], {})
    check(r.ok === false && String(r.error && r.error.kind) === 'conflict', 'C10 自己阻塞自己 → conflict（实得 ' + (r.error && r.error.kind) + '）')
    check(remote.writeCalls.length === 0 && remote.calls.length === before, 'C11 自阻塞时连请求都不发')
  }
  {
    const remote = makeRemote({})
    remote.store.get('8').body = '## Blocked by\n- 实施票九十（#90）'
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const beforeBody = remote.store.get('90').body
    const r = await tracker.setBlockedBy(repo, '90', ['8'], {})
    check(r.ok === false && String(r.error && r.error.kind) === 'conflict', 'C12 写完会成环 → conflict（实得 ' + (r.error && r.error.kind) + '）')
    check(remote.store.get('90').body === beforeBody && remote.writeCalls.length === 0, 'C13 成环时一个字都没写进票面')
  }
  {
    const remote = makeRemote({ bodyWriteFails: true })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setBlockedBy(repo, '90', ['8'], {})
    const msg = String((r.error && r.error.message) || '')
    check(r.ok === false, 'C14 正文写不进去时如实失败（实得 ok=' + r.ok + '）')
    check(msg.indexOf('写正文失败') >= 0 && msg.indexOf('来源：正文') >= 0, 'C15 失败原话写清「关系只能写进正文、写正文失败」（原话：' + msg.slice(0, 100) + '）')
    check(remote.store.get('90').body === '原正文', 'C16 写失败后票面正文没被改动')
  }
  {
    const remote = makeRemote({ readBackFails: (key: string) => key === '9' })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setBlockedBy(repo, '90', ['9'], {})
    const msg = String((r.error && r.error.message) || '')
    check(r.ok === false && msg.indexOf('阻塞票 #9 读不回来') >= 0, 'C17 阻塞票读不回来就如实失败、不写半截（原话：' + msg.slice(0, 100) + '）')
    check(remote.writeCalls.length === 0, 'C18 读不全时根本没发改正文的请求')
  }
  {
    const remote = makeRemote({ readBackFails: (key: string, n: number) => key === '90' && n >= 2 })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setBlockedBy(repo, '90', ['8'], {})
    const msg = String((r.error && r.error.message) || '')
    check(r.ok === false && msg.indexOf('读不回来') >= 0 && msg.indexOf('无法确认') >= 0, 'C19 回包说成功但写后读不回来时如实失败（原话：' + msg.slice(0, 100) + '）')
  }
  {
    const remote = makeRemote({})
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    remote.store.get('90').updated_at = '2026-11-26T10:00:00+08:00'
    const r = await tracker.setBlockedBy(repo, '90', ['8'], { expectedUpdatedAt: '2026-11-26T09:00:00+08:00' })
    check(r.ok === false && String(r.error && r.error.kind) === 'conflict', 'C20 写前版本对不上 → conflict（实得 ' + (r.error && r.error.kind) + '）')
    check(remote.writeCalls.length === 0, 'C21 版本对不上时一个字都不写')
  }

  // ---- D) 落点规则与读票回执按来源标「正文行」----
  {
    const after = { issue: { key: '90', blockedBy: [{ key: '8', title: '阻塞票八' }], blockedBySource: 'body', body: '## Blocked by\n- 阻塞票八（#8）' } }
    const ev = rules.classifyEdgeLanding('block', '8', after, '90')
    check(ev.kind === 'body-line' && ev.text.indexOf('来源：正文') >= 0 && ev.text.indexOf('## Blocked by') >= 0, 'D1 来源正文且小节里有它 → 落点「正文行」并点名小节（实得 ' + ev.kind + '：' + ev.text.slice(0, 90) + '）')
    check(rules.landingOf('block', ev) === rules.EDGE_LANDING.BODY_LINE, 'D2 落点常量记成「正文行」')
    const plain = { issue: { key: '90', blockedBy: [{ key: '8', title: '阻塞票八' }], body: '## Blocked by\n- 阻塞票八（#8）' } }
    const old = rules.classifyEdgeLanding('block', '8', plain, '90')
    check(old.text.indexOf('来源：') < 0, 'D3 没标来源的后端落点文案逐字不变（不出现来源标注）：' + old.text.slice(0, 80))
    const native = rules.classifyEdgeLanding('block', '8', { issue: { key: '90', blockedBy: [{ key: '8' }], body: '正文' } }, '90')
    check(native.kind === 'native' && native.text.indexOf('原生边') >= 0, 'D4 GitHub 那种「结构字段里有、正文里没有」仍判原生边')
  }
  {
    const budget = await imp('src/refresh/kernel/host-budget.js')
    const ledgerMod = await imp('src/refresh/rooms/host/quota-ledger.ts')
    const gateMod = await imp('src/refresh/rooms/host/refresh-gate.ts')
    const registryMod = await imp('src/tracker/registry/core.ts')
    const toolCost = await imp('src/refresh/kernel/tool-call-budget.js')
    const getMod = await imp('src/deck/tools/issue-get.ts')
    const clock = 1700000000000
    const ledger = ledgerMod.createLedger({ now: () => clock })
    const gate = gateMod.createGate({ ledger: ledger, now: () => clock })
    ledger.ensureBackend('github', { kind: 'two-buckets' })
    ledger.syncServer('github', { rest: { limit: 5000, remaining: 5000, reset: clock + 3600000 }, graphql: { limit: 5000, remaining: 5000, reset: clock + 3600000 } }, clock)
    const registry = registryMod.createRegistry({ logEvent: () => {}, isEnabled: () => false }, { matchesTimeout: 200 })
    let row: any = null
    // 反向边的来源标注要能逐案开关：D9 验「没标来源的后端回执一字不变」，D7/D10 验「标了来源就写出来」。
    let blockingEdges: any[] = [{ key: '91', title: '下游票九十一', state: 'open', source: 'body' }]
    const stub = {
      id: 'stub-11-get', label: '桩（阻塞来源标注）', matches: async () => false,
      budget: { kind: 'off-network', countsRequests: false, countsPoints: false, independentBuckets: false },
      create: () => ({
        id: 'stub-11-get',
        async get(repoArg: any, key: string) { return { ok: true, data: row } },
        async getDependencies() {
          return { ok: true, data: { blockedBy: [{ key: '8', title: '阻塞票八', state: 'open' }, { key: '9', title: '阻塞票九', state: 'closed' }], blocking: blockingEdges, blockedByComplete: true, blockingComplete: true, blockingSource: 'scan' } }
        },
      }),
    }
    const disp = registry.register(stub)
    chooseWorkspace('/ws/11', 'stub-11-get')
    const deps = {
      gate, registry, budget, estimate: toolCost.estimateToolCost, costInputFrom: toolCost.toolCostInputFrom,
      handleFor: () => ({ cwd: '/ws/11', refId: 'o/r' }), backendCtx: {}, now: () => clock, log: { fire: () => {} }, invalidate: () => {},
      decideBackend: makeDecideStub(registry),
    }
    const getTool = getMod.createDeckIssueGet(deps)
    const exec = { agent: { session: { id: 's-11', cwd: '/ws/11' } } }
    base: {
      row = { key: '90', title: '实施票九十', state: 'open', type: 'issue', body: '## Blocked by\n- 阻塞票八（#8）\n- 阻塞票九（#9）', url: '', labels: [], assignees: [], parentKey: null, blockedBy: [{ key: '8', title: '阻塞票八', state: 'open' }, { key: '9', title: '阻塞票九', state: 'closed' }], blockedBySource: 'body' }
      const res = await getTool.run(exec, { key: '90' })
      check(res.status === 'ok' && res.data.landings.blockedBy === rules.EDGE_LANDING.BODY_LINE, 'D5 读票回执把被阻塞落点记成「正文行」（实得 ' + String(res.data && res.data.landings && res.data.landings.blockedBy) + '）')
      check(String(res.text).indexOf('被阻塞 2 条（来源：正文）') >= 0, 'D6 抬头写清被阻塞关系来自正文：' + String(res.text).slice(0, 90))
      check(String(res.text).indexOf('阻塞别人 1 条（来源：正文）') >= 0, 'D7 反向关系也标来源正文（扫票面扫出来的）')
      check(String(res.data.landings.caveat).indexOf('## Blocked by') >= 0 && String(res.data.landings.caveat).indexOf('来源：正文') >= 0, 'D8 注记说清落在票正文末尾的小节上')
      blockingEdges = [{ key: '91', title: '下游票九十一', state: 'open' }]
      row = { key: '90', title: '实施票九十', state: 'open', type: 'issue', body: '正文', url: '', labels: [], assignees: [], parentKey: null, blockedBy: [{ key: '8' }] }
      const plain = await getTool.run(exec, { key: '90' })
      check(plain.data.landings.blockedBy === rules.EDGE_LANDING.CONTRACT_BLOCK_FIELD && String(plain.text).indexOf('来源：') < 0, 'D9 没标来源的后端回执与今天一模一样（不出现来源标注）')
      // F4：本票自己没被谁挡住（blockedBy 为空、没有 blockedBySource），但反向边是从别人正文扫出来的。
      // 这时「阻塞了谁」的来源只能看边上自己的标注，借本票那一格就说不出话。
      blockingEdges = [{ key: '91', title: '下游票九十一', state: 'open', source: 'body' }]
      row = { key: '90', title: '实施票九十', state: 'open', type: 'issue', body: '正文', url: '', labels: [], assignees: [], parentKey: null, blockedBy: [] }
      const onlyReverse = await getTool.run(exec, { key: '90' })
      check(String(onlyReverse.text).indexOf('阻塞别人 1 条（来源：正文）') >= 0 && String(onlyReverse.text).indexOf('被阻塞 0 条（来源') < 0, 'D10 只挡别人、自己没被阻塞时，反向关系照样标来源正文：' + String(onlyReverse.text).slice(0, 90))
      disp.dispose()
    }
  }

  // ---- E) 地图「只看可接」按 blockedBy 排除 ----
  {
    const budget = await imp('src/refresh/kernel/host-budget.js')
    const ledgerMod = await imp('src/refresh/rooms/host/quota-ledger.ts')
    const gateMod = await imp('src/refresh/rooms/host/refresh-gate.ts')
    const registryMod = await imp('src/tracker/registry/core.ts')
    const toolCost = await imp('src/refresh/kernel/tool-call-budget.js')
    const snapMod = await imp('src/deck/tools/map-snapshot.ts')
    const clock = 1700000000000
    const ledger = ledgerMod.createLedger({ now: () => clock })
    const gate = gateMod.createGate({ ledger: ledger, now: () => clock })
    ledger.ensureBackend('github', { kind: 'two-buckets' })
    ledger.syncServer('github', { rest: { limit: 5000, remaining: 5000, reset: clock + 3600000 }, graphql: { limit: 5000, remaining: 5000, reset: clock + 3600000 } }, clock)
    const registry = registryMod.createRegistry({ logEvent: () => {}, isEnabled: () => false }, { matchesTimeout: 200 })
    let blockerState = 'open'
    const mapRow = { key: '30', title: '地图三十', state: 'open', type: 'map', body: '## Destination\n做点东西', url: '', labels: [], assignees: [], parentKey: null }
    const kids = () => [
      { key: '20', title: '被阻塞的票', state: 'open', type: 'issue', body: '', url: '', labels: [], assignees: [], parentKey: '30', blockedBy: [{ key: '21', title: '阻塞票二十一' }] },
      { key: '21', title: '阻塞票二十一', state: blockerState, type: 'issue', body: '', url: '', labels: [], assignees: [], parentKey: '30', blockedBy: [] },
      { key: '22', title: '没人挡的票', state: 'open', type: 'issue', body: '', url: '', labels: [], assignees: [], parentKey: '30', blockedBy: [] },
    ]
    const stub = {
      id: 'stub-11-map', label: '桩（只看可接按 blockedBy 筛）', matches: async () => false,
      budget: { kind: 'off-network', countsRequests: false, countsPoints: false, independentBuckets: false },
      create: () => ({
        id: 'stub-11-map',
        async get(repoArg: any, key: string) { return { ok: true, data: String(key) === '30' ? mapRow : null } },
        async list() { return { ok: true, data: kids() } },
      }),
    }
    const disp = registry.register(stub)
    chooseWorkspace('/ws/11', 'stub-11-map')
    const deps = {
      gate, registry, budget, estimate: toolCost.estimateToolCost, costInputFrom: toolCost.toolCostInputFrom,
      handleFor: () => ({ cwd: '/ws/11', refId: 'o/r' }), backendCtx: {}, now: () => clock, log: { fire: () => {} }, invalidate: () => {},
      decideBackend: makeDecideStub(registry),
    }
    const snapTool = snapMod.createDeckMapSnapshot(deps)
    const exec = { agent: { session: { id: 's-11', cwd: '/ws/11' } } }
    const pick = (res: any): string[] => {
      const list = (res.data && res.data.children) || []
      return list.map((t: any) => String(t.key)).sort()
    }
    const first = await snapTool.run(exec, { key: '30', frontierOnly: true, detail: 'thin' })
    check(first.status === 'ok' && pick(first).join(',') === '21,22', 'E1 被开着的票挡住的工单不出现在可接里（实得 ' + pick(first).join(',') + '）')
    check(String(first.text).indexOf('可接 2 张') >= 0 && String(first.text).indexOf('被阻塞 1 张') >= 0, 'E2 回执说清可接几张、被阻塞几张：' + String(first.text).slice(0, 100))
    blockerState = 'closed'
    const second = await snapTool.run(exec, { key: '30', frontierOnly: true, detail: 'thin' })
    check(second.status === 'ok' && pick(second).join(',') === '20,22', 'E3 阻塞票关掉后被挡的工单回到可接，关闭的那张自己不再算可接（实得 ' + pick(second).join(',') + '）')
    const all = await snapTool.run(exec, { key: '30', detail: 'thin' })
    check(pick(all).join(',') === '20,21,22', 'E4 不带 frontierOnly 时三张全列（筛法只在开只看可接时生效）')
    disp.dispose()
  }

  console.log(failed ? ('门禁失败：' + total + ' 条断言里有失败') : ('门禁通过：' + total + ' 条断言全绿'))
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('门禁执行异常：' + ((e && e.stack) || e)); process.exit(1) })
