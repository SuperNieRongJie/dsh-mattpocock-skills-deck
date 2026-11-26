/**
 * tests/verify-10-gitee-single-assignee.ts —— 票 #10：Gitee 的认领人只能有一个负责人
 *
 * 守四件事：
 *   1. 0 个人清空、1 个人直接写都真的写进远端的 assignee 字段；
 *   2. 一次给 2 个人以上时动手前就如实拒绝，回执里有「这张票只能挂一个负责人」，
 *      远端一个字节都没动，也没有拿「协助者」之类的字段冒充第二负责人；
 *   3. 远端写入失败时的措辞仍是原来那一套（远端原话优先，没有原话才用固定句），没有另造说法；
 *   4. deck 的 deck_issue_patch 把多人请求回成失败的、读得懂的回执，不报成功。
 *
 * 跑法：node --import ./scripts/ts-hook.mts tests/verify-10-gitee-single-assignee.ts
 */
const path = require('path')
const { pathToFileURL } = require('url')
const { makeDecideStub, chooseWorkspace } = require('./lib/deck-decide-stub.js')

const ROOT = path.resolve(__dirname, '..')
let failed = false
let total = 0
const check = (ok: boolean, msg: string): void => { total += 1; console.log((ok ? '  PASS ' : '  FAIL ') + msg); if (!ok) failed = true }
const imp = (rel: string): Promise<any> => import(pathToFileURL(path.join(ROOT, rel)).href)

/** 房层要用到的上下文：只给 cwd、模拟的可执行文件解析、以及一条假的 gitee 命令。 */
function fakeCtx(exec: any) {
  return {
    cwd: '/ws/10',
    platform: { resolveExecutable: async (name: string) => (name === 'gitee' ? 'C:\\fake\\gitee.exe' : 'C:\\fake\\node.exe') },
    exec: exec,
  }
}

/** 一张票的远端形状；assignee 是单值（字符串或 null），没有第二个负责人位置。 */
function seedRow(key: string, title: string, assignee?: string) {
  return { id: Number(key) * 10 + 1, number: key, title: title, state: 'open', body: '原正文', labels: [], assignee: assignee || null }
}

/** 远端回包里的负责人是对象（{\"login\": \"alice\"}），而写请求里给的是登录名字符串，两边形状不同。 */
function replyOf(row: any) {
  const out = Object.assign({}, row)
  out.assignee = row.assignee ? { login: row.assignee, name: row.assignee } : null
  return JSON.stringify(out)
}

/** 假的 gitee 命令行：GET 读票、PATCH 改票；改认领人只认 assignee 字段，并记下每次写了什么。 */
function makeRemote(opts?: any) {
  const o = opts || {}
  const store = new Map()
  store.set('10', seedRow('10', '实施票十', 'alice'))
  store.set('11', seedRow('11', '没有负责人的票十一'))
  const calls: string[] = []
  const writes: any[] = []
  function exec(cmd: string, args: string[]) {
    calls.push([cmd].concat(args).join(' '))
    const target = String(args[1] || '')
    const mi = args.indexOf('--method')
    const method = mi >= 0 ? String(args[mi + 1] || '').toUpperCase() : 'GET'
    const bi = args.indexOf('--body')
    const payload = bi >= 0 ? JSON.parse(String(args[bi + 1] || '{}')) : {}
    const single = /^repos\/o\/(?:r\/)?issues\/([^/?]+)$/.exec(target)
    if (method === 'GET' && single) {
      if (o.readFails) return { code: 1, stdout: '', stderr: '500 单票读失败' }
      const row = store.get(decodeURIComponent(single[1]))
      if (!row) return { code: 1, stdout: '', stderr: '404 not found' }
      return { code: 0, stdout: replyOf(row), stderr: '' }
    }
    if (method === 'PATCH' && single) {
      const key = decodeURIComponent(single[1])
      const row = store.get(key)
      if (!row) return { code: 1, stdout: '', stderr: '404 not found' }
      if (o.writeFails) return { code: 1, stdout: '', stderr: o.writeFails === 'silent' ? '' : '403 没有改票权限' }
      writes.push({ key: key, payload: payload })
      if (payload.assignee !== undefined) row.assignee = String(payload.assignee) || null
      return { code: 0, stdout: replyOf(row), stderr: '' }
    }
    return { code: 1, stdout: '', stderr: 'unexpected request: ' + method + ' ' + target }
  }
  return { exec: exec, calls: calls, writes: writes, store: store, opts: o }
}

async function main() {
  console.log('Gitee 单负责人门禁（#10：单人可写、清空可用、多人如实拒绝、失败措辞不变）')

  // ---- A) 能力登记：多人被拒是契约合法输入被拒，档位必须是「做了但没做到位」----
  const regMod = await imp('src/tracker/rooms/gitee/support/capability-register.ts')
  const entry = regMod.GITEE_CAPABILITY_REGISTER.setAssignees
  check(entry.tier === 'partial', 'A1 setAssignees 登记成「做了但没做到位」（实得 ' + entry.tier + '）')
  check(String(entry.gap || '').indexOf('一个负责人位置') >= 0, 'A2 缺口的说明写清「只有一个负责人位置」（实得：' + String(entry.gap || '').slice(0, 60) + '）')
  check(String(entry.ticket || '') === '10', 'A3 缺口挂着承接票 #10（实得 ' + entry.ticket + '）')

  const giteeMod = await imp('src/tracker/rooms/gitee/index.ts')
  const repo = { refId: 'o/r' }

  // ---- B) 房层：1 个人直接写、0 个人清空 ----
  {
    const remote = makeRemote({})
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setAssignees(repo, '11', ['alice'], {})
    check(r.ok === true && remote.store.get('11').assignee === 'alice', 'B1 写一个负责人能成功，远端 assignee 就是那个人（实得 ok=' + r.ok + '，assignee=' + String(remote.store.get('11').assignee) + '）')
    check(remote.writes.length === 1 && remote.writes[0].payload.assignee === 'alice', 'B2 只发了一次改票请求，正文里只有 assignee 一个字段（实得 ' + JSON.stringify(remote.writes.map((w: any) => w.payload)) + '）')
    const cleared = await tracker.setAssignees(repo, '11', [], {})
    check(cleared.ok === true && remote.store.get('11').assignee === null, 'B3 传空清单就是清空负责人（实得 ok=' + cleared.ok + '，assignee=' + String(remote.store.get('11').assignee) + '）')
    check(remote.writes.length === 2 && remote.writes[1].payload.assignee === '', 'B4 清空写的是空串，不是不发请求（实得 ' + JSON.stringify(remote.writes[1].payload) + '）')
  }

  // ---- C) 房层：2 个人以上动手前拒绝，不写远端、不写协助者 ----
  {
    const remote = makeRemote({})
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const before = JSON.stringify(remote.store.get('10'))
    const r = await tracker.setAssignees(repo, '10', ['alice', 'bob'], {})
    const msg = String((r.error && r.error.message) || '')
    check(r.ok === false && String(r.error && r.error.kind) === 'unsupported', 'C1 两个人一起写 → 如实回 unsupported（实得 ok=' + r.ok + '，kind=' + String(r.error && r.error.kind) + '）')
    check(msg.indexOf('这张票只能挂一个负责人') >= 0, 'C2 回执里写清「这张票只能挂一个负责人」（原话：' + msg + '）')
    check(msg.indexOf('alice') >= 0 && msg.indexOf('bob') >= 0, 'C3 回执点名这次给出的两个人，人能自己对照改输入')
    check(String(r.error && r.error.stage) === 'input-refused', 'C4 失败阶段标成「输入被拒」，好让回执告诉人改输入就能重试（实得 ' + String(r.error && r.error.stage) + '）')
    check(remote.writes.length === 0 && remote.calls.every((c: string) => c.indexOf('--method PATCH') < 0), 'C5 拒绝发生在动手前，一次改票请求都没发（实得 ' + remote.writes.length + ' 次写）')
    check(JSON.stringify(remote.store.get('10')) === before, 'C6 远端那张票一个字节都没动')
    const row: any = remote.store.get('10')
    check(row.assignee === 'alice' && row.collaborators === undefined && row.assignees === undefined, 'C7 没有拿协助者字段或其他字段冒充第二负责人（远端只有 assignee 一格）')
  }
  {
    // 同一个人写两遍不算两个人：去重之后仍是单值，照常写进去。
    const remote = makeRemote({})
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setAssignees(repo, '11', ['alice', 'alice'], {})
    check(r.ok === true && remote.store.get('11').assignee === 'alice', 'C8 同一个名字重复两次按一个人处理，照常写成功（实得 ok=' + r.ok + '）')
  }

  // ---- D) 远端写入失败的措辞与原来一致 ----
  {
    const remote = makeRemote({ writeFails: true })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const r = await tracker.setAssignees(repo, '11', ['alice'], {})
    const msg = String((r.error && r.error.message) || '')
    check(r.ok === false && msg === '403 没有改票权限', 'D1 远端有原话就原样带回，不另造说法（实得：' + msg + '）')
  }
  {
    // 与同一间房里早就存在的写动作（改标签）比：同一个远端、同一种失败，措辞必须一模一样，
    // 也就是说这次改动没有给认领人另造一套说法。
    const remote = makeRemote({ writeFails: 'silent' })
    const tracker = giteeMod.giteeBackend.create(fakeCtx(remote.exec))
    const mine = await tracker.setAssignees(repo, '11', ['alice'], {})
    const sib = await tracker.setLabels(repo, '11', ['x'], {})
    const mineErr = mine.error || {}
    const sibErr = sib.error || {}
    check(mine.ok === false && sib.ok === false
      && String(mineErr.kind) === String(sibErr.kind)
      && String(mineErr.message) === String(sibErr.message)
      && String(mineErr.message).length > 0,
      'D2 远端静默失败时，认领人回执与同房已有的改标签回执一字不差（认领：' + mineErr.kind + ' / ' + mineErr.message + '；改标签：' + sibErr.kind + ' / ' + sibErr.message + '）')
  }
  {
    const throwing = () => { throw new Error('gitee 命令没能启动') }
    const tracker = giteeMod.giteeBackend.create(fakeCtx(throwing))
    const mine = await tracker.setAssignees(repo, '11', ['alice'], {})
    const sib = await tracker.setLabels(repo, '11', ['x'], {})
    const mineErr = mine.error || {}
    const sibErr = sib.error || {}
    check(mine.ok === false && sib.ok === false
      && String(mineErr.kind) === String(sibErr.kind)
      && String(mineErr.message) === String(sibErr.message),
      'D3 命令启动就抛错时，认领人回执同样与改标签回执一字不差（认领：' + mineErr.kind + ' / ' + mineErr.message + '）')
  }

  // ---- E) deck 回执：多人请求报失败、读得懂；单人与清空照常成功 ----
  {
    const budget = await imp('src/refresh/kernel/host-budget.js')
    const ledgerMod = await imp('src/refresh/rooms/host/quota-ledger.ts')
    const gateMod = await imp('src/refresh/rooms/host/refresh-gate.ts')
    const registryMod = await imp('src/tracker/registry/core.ts')
    const toolCost = await imp('src/refresh/kernel/tool-call-budget.js')
    const patchMod = await imp('src/deck/tools/issue-patch.ts')
    const clock = 1700000000000
    const remote = makeRemote({})
    const ctx = fakeCtx(remote.exec)
    const ledger = ledgerMod.createLedger({ now: () => clock })
    const gate = gateMod.createGate({ ledger: ledger, now: () => clock })
    ledger.ensureBackend('gitee', { kind: 'requests-only' })
    const registry = registryMod.createRegistry({ logEvent: () => {}, isEnabled: () => false, platform: ctx.platform, exec: remote.exec, cwd: ctx.cwd }, { matchesTimeout: 200 })
    const disp = registry.register(giteeMod.giteeBackend)
    chooseWorkspace('/ws/10', 'gitee')
    const planTable = new Map()
    const deps = {
      gate: gate, registry: registry, budget: budget, estimate: toolCost.estimateToolCost, costInputFrom: toolCost.toolCostInputFrom,
      backendCtx: ctx, handleFor: () => ({ cwd: '/ws/10', refId: 'o/r' }), decideBackend: makeDecideStub(registry),
      log: { fire: () => {} }, now: () => clock, invalidate: () => {},
      workRouteNote: () => null, workRouteRead: () => null, workRouteRelease: () => null,
      planStore: { durable: true, load: (id: string) => planTable.get(String(id)) || null, save: (id: string, s: any) => { planTable.set(String(id), s) } },
    }
    const patchTool = patchMod.createDeckIssuePatch(deps)
    const exec = { agent: { session: { id: 's-10', cwd: '/ws/10' } } }
    const before = JSON.stringify(remote.store.get('10'))
    const two = await patchTool.run(exec, { key: '10', assignees: ['alice', 'bob'] })
    check(two.status !== 'ok', 'E1 deck_issue_patch 多人认领不报成功（实得 status=' + two.status + '）')
    check(String(two.text).indexOf('只能挂一个负责人') >= 0, 'E2 回执里有「只能挂一个负责人」，人不用去猜为什么没记上（回执：' + String(two.text).slice(0, 160) + '）')
    check(String(two.text).indexOf('如实拒绝') >= 0 && String(two.text).indexOf('别当成已经记上') >= 0, 'E3 回执说清这是一次拒绝、不是已经写好了')
    check(JSON.stringify(remote.store.get('10')) === before, 'E4 回执说失败的同时，远端票面确实一个字节没动')
    const one = await patchTool.run(exec, { key: '11', assignees: ['carol'] })
    check(one.status === 'ok' && remote.store.get('11').assignee === 'carol', 'E5 单人认领照常成功，并写后读回核对（实得 status=' + one.status + '，assignee=' + String(remote.store.get('11').assignee) + '）')
    const clear = await patchTool.run(exec, { key: '11', assignees: [] })
    check(clear.status === 'ok' && remote.store.get('11').assignee === null, 'E6 清空负责人也照常成功（实得 status=' + clear.status + '，assignee=' + String(remote.store.get('11').assignee) + '）')
    disp.dispose()
  }

  console.log(failed ? ('门禁失败：' + total + ' 条断言里有失败') : ('门禁通过：' + total + ' 条断言全绿'))
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error('门禁执行异常：' + ((e && e.stack) || e)); process.exit(1) })