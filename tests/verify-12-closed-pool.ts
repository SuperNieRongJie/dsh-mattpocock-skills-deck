// tests/verify-12-closed-pool.ts —— 票 #12 门禁：刷新那一轮多要一页已关闭票，顶部「已关闭 N」跟着库里的行涨
// 门禁归属: src/host/tracker/snapshotWorkingSet.ts
// 门禁归属: src/host/tracker/snapshot.ts
// 门禁归属: src/refresh/rooms/host/session-refresh-schedule.ts
//
// 判据（票 #12 的验收逐条对应下面的断言组）：
//   A 首屏仍不新增查询：不传 closedPool 时一次关闭池查询都不发（list 仍恰好一次、筛选是开放票；
//     listPage 至多只剩 #1796 就有的「已关闭地图容器页」那一次），日志四格恒为 0 / 0 / 0 / 空串；
//   B 刷新那一轮恰好一次关闭池查询：筛选 `{ state: 'closed' }`（不带标签，关闭票不分类型）、
//     条数上限 CLOSED_POOL_PAGE_LIMIT=100；按轮计数写进 snapshot.workingSet 日志；
//   C 「从没开着过」的关闭票被补进这一轮的票行（因此会经 onRows 写进快照库），拉取请求、容器子票、
//     并集里已有的票都不重复补；
//   D 真 SQLite 库：首屏那批行写进去 counts.closed 仍是 0；刷新那批写进去 counts.closed 变 1，
//     与另写一条 SQL 独立数出来的结果逐项相等，counts.open 不变（关闭票不进开放统计）；
//   E 关闭池查询失败不炸整轮：抛异常记 'thrown'、回包 ok:false 记它的 error.kind；后端实例没有
//     listPage 成员时一次都不发（G5：只看实例成员，不查能力登记表）；
//   F 接线静态判据：刷新调度主路径与回退路径各传一处 `closedPool: true`，首屏缓存一处都不传。
//
// 为什么用真库：验收第一句是「刷新后『已关闭 N』与实际关闭票数一致」，而那个数字来自快照库的
//   counts 投影（src/workspace-snapshot/projection/counts.ts）。只断言内存里补了几行，证明不了写库之后
//   数字会变；所以 C 组拿到的行原样交给 recordIssueRows，再读库里的计数，并用一条独立 SQL 复核。
//   counts.ts 的计数口径一行不改，本门禁只从外部观察它。
//
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-12-closed-pool.ts
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { printGateResult } from './lib/gate-result.ts'
import { defaultSnapshotDbPath } from '../src/workspace-snapshot/runtime/paths.ts'

const GATE = 'verify-12-closed-pool'
const ROOT = process.cwd()
const MAP_LABEL = 'wayfinder:map'
const CLOSED_POOL_PAGE_LIMIT = 100

let total = 0
let failed = 0
function check(ok: unknown, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + JSON.stringify(detail).slice(0, 300)))
}

const { createSnapshotComposer } = await import('../src/host/tracker/snapshot.ts')
const { recordIssueRows, readSnapshotCounts, closeSnapshotLibraries } = await import('../src/refresh/rooms/host/snapshot-library.ts')

/** 一行票：形状与各后端归一层的产出一致（宿主组装层只读这几格）。 */
function issue(key: string, extra?: Record<string, any>): any {
  return Object.assign({
    key, number: Number.isFinite(Number(key)) ? Number(key) : 0, effortId: '', type: 'issue',
    title: '票 ' + key, state: 'OPEN', body: '正文 ' + key, url: 'https://example.test/issues/' + key,
    parentKey: null, labels: [], assignees: [], blockedBy: [], isPullRequest: false,
  }, extra || {})
}

const REF = { refId: 'acme/demo', owner: 'acme', name: 'demo' }
const CTX = { cwd: 'D:\\ws' }

/** 这一趟开放池里有哪些票、关闭池回什么、要不要失败，全由 phase 决定；调用次数与入参如实记下来。 */
const phase: any = { open: [], closed: [], closedMode: 'ok' }
const calls = { list: 0, listPage: 0, listSubIssues: 0 }
const listFilters: any[] = []
const listPageCalls: any[] = []
const tracker = {
  list: async (_ref: any, filter: any) => {
    calls.list += 1
    listFilters.push(filter || {})
    return { ok: true, data: (phase.open || []).map((r: any) => Object.assign({}, r)) }
  },
  listPage: async (_ref: any, filter: any, opts: any) => {
    calls.listPage += 1
    listPageCalls.push({ filter: filter || {}, opts: opts || {} })
    if (phase.closedMode === 'throw') throw new Error('关闭池查询炸了（门禁故意）')
    if (phase.closedMode === 'transport') return { ok: false, error: { kind: 'transport', message: '连不上' } }
    const isClosedPool = filter && filter.state === 'closed' && !(filter.labels && filter.labels.length)
    // 翻页两档：closedPages 给出逐页内容（最后一页没有下一页游标），closedAlwaysMore 模拟「永远还有下一页」。
    if (isClosedPool && Array.isArray(phase.closedPages)) {
      const idx = opts && opts.cursor ? Number(opts.cursor) - 1 : 0
      const items = phase.closedPages[idx] || []
      const next = idx + 1 < phase.closedPages.length ? String(idx + 2) : null
      return { ok: true, data: { items: items.map((r: any) => Object.assign({}, r)), nextCursor: next } }
    }
    const items = isClosedPool ? (phase.closed || []) : []
    const nextCursor = isClosedPool && phase.closedAlwaysMore === true ? String(Number(opts && opts.cursor ? opts.cursor : 1) + 1) : null
    return { ok: true, data: { items: items.map((r: any) => Object.assign({}, r)), nextCursor } }
  },
  listSubIssues: async () => { calls.listSubIssues += 1; return { ok: true, data: { items: [] } } },
}

/** 日志探针：snapshot.workingSet 是「这一轮关闭池发了几次、回了几条、补了几条」的唯一读数。 */
const wsEvents: any[] = []
const logCtx: any = {
  fire: function (_lvl: string, ev: string, fields: any) {
    if (ev === 'snapshot.workingSet') wsEvents.push(fields || {})
  },
}
const composer = createSnapshotComposer({ get: () => tracker }, { logCtx })

function lastEvent(): any { return wsEvents[wsEvents.length - 1] || {} }
function closedPoolCallsFrom(mark: number): any[] {
  return listPageCalls.slice(mark).filter((c) => c.filter && c.filter.state === 'closed' && !(c.filter.labels && c.filter.labels.length))
}

// ── A 首屏：不传 closedPool 就一次关闭池查询都不发 ──────────────────────────────
phase.open = [
  issue('M1', { type: 'map', state: 'OPEN' }),
  issue('1', { state: 'OPEN' }),
]
let firstRows: any[] = []
const first: any = await composer.composeSnapshot('gitee', REF, CTX, { onRows: (rows: any[]) => { firstRows = rows } })
check(calls.list === 1 && listFilters[0].state === 'open', 'A1 首屏开放池只拉一次且筛选是开放票', { calls, listFilters })
check(closedPoolCallsFrom(0).length === 0, 'A2 首屏不发关闭池查询', listPageCalls)
check(listPageCalls.filter((c) => c.filter && c.filter.labels && c.filter.labels.indexOf(MAP_LABEL) >= 0).length <= 1,
  'A3 首屏最多只有 #1796 那一趟「已关闭地图容器页」', listPageCalls)
const evA = lastEvent()
check(evA.closedPoolQueries === 0 && evA.closedPoolRows === 0 && evA.closedPoolAdded === 0 && evA.closedPoolError === '',
  'A4 首屏日志四格恒为 0 / 0 / 0 / 空串', { closedPoolQueries: evA.closedPoolQueries, closedPoolRows: evA.closedPoolRows, closedPoolAdded: evA.closedPoolAdded, closedPoolError: evA.closedPoolError })
check(firstRows.some((r) => r.key === '1') && !firstRows.some((r) => r.key === '7'), 'A5 首屏票行里没有只在关闭池里的票', firstRows.map((r) => r.key))

// ── B/C 刷新那一轮：一次关闭池查询，把「从没开着过」的关闭票补进这一批行 ─────────
phase.closed = [
  issue('7', { state: 'CLOSED', title: '从来没开着过的关闭票' }),
  issue('8', { state: 'CLOSED', isPullRequest: true }),
  issue('9', { state: 'CLOSED', parentKey: 'M1' }),
  issue('7', { state: 'CLOSED', title: '同一张票重复出现' }),
]
const mark2 = listPageCalls.length
let refreshRows: any[] = []
const second: any = await composer.composeSnapshot('gitee', REF, CTX, {
  force: true, closedPool: true, previousSnapshot: first.snapshot,
  onRows: (rows: any[]) => { refreshRows = rows },
})
const evB = lastEvent()
const poolCalls2 = closedPoolCallsFrom(mark2)
check(poolCalls2.length === 1, 'B1 刷新这一轮恰好发一次关闭池查询', listPageCalls.slice(mark2))
check(poolCalls2[0] && poolCalls2[0].filter.state === 'closed' && !poolCalls2[0].filter.labels,
  'B2 关闭池查询的筛选是 state=closed 且不带标签（不按类型分池）', poolCalls2[0] && poolCalls2[0].filter)
check(poolCalls2[0] && poolCalls2[0].opts && poolCalls2[0].opts.limit === CLOSED_POOL_PAGE_LIMIT,
  'B3 关闭池查询的条数上限是 ' + CLOSED_POOL_PAGE_LIMIT + '（有界）', poolCalls2[0] && poolCalls2[0].opts)
check(evB.closedPoolQueries === 1, 'B4 日志里这一轮关闭池查询次数是 1（能与首屏那一轮的 0 分开数）', evB)
check(evB.closedPoolRows === 4, 'B5 日志里关闭池回包条数如实记 4 条', evB.closedPoolRows)
check(evB.closedPoolRows === phase.closed.length, 'B6 日志条数与远端回包条数一致', { logged: evB.closedPoolRows, returned: phase.closed.length })
check(evB.closedPoolAdded === 1 && evB.closedPoolError === '', 'C1 四张里只有那张没进过开放池的补进并集，且没有失败档', evB)
const added7 = refreshRows.filter((r) => r.key === '7')
check(added7.length === 1 && String(added7[0].state).toUpperCase() === 'CLOSED', 'C2 补进来的行是已关闭状态，且重复出现的那张只补一次', added7)
check(added7.length === 1 && added7[0].type === 'issue' && added7[0].title === '从来没开着过的关闭票', 'C3 补进来的行保留原票的关键信息（读与写都要靠它）', added7[0])
check(!refreshRows.some((r) => r.key === '8'), 'C4 关闭池里的拉取请求不补', refreshRows.map((r) => r.key))
check(!refreshRows.some((r) => r.key === '9'), 'C5 关闭池里的容器子票（带 parentKey）不补', refreshRows.map((r) => r.key))
check(refreshRows.some((r) => r.key === '1') && refreshRows.some((r) => r.key === 'M1'), 'C6 开放池原有的票一张不少', refreshRows.map((r) => r.key))
check(second.snapshot && second.snapshot.issues && second.snapshot.issues.some((r: any) => r.key === '7'),
  'C7 补进来的票行进了这一轮的快照（面板「已关闭」档看的就是它）')

// ── D 真库：把两轮票行原样写进去，顶部数字跟着库走 ──────────────────────────────
function makeWorkspace(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix))
  mkdirSync(path.join(dir, 'docs', 'agents'), { recursive: true })
  writeFileSync(path.join(dir, 'docs', 'agents', 'workspace.yaml'), 'name: ' + prefix + '\n', 'utf8')
  return dir
}

/** 独立数一遍：不用被测的 counts 投影，直接按同一口径读库。 */
function closedCountIndependently(dbPath: string): { open: number, closed: number, total: number } {
  const db = new DatabaseSync(dbPath)
  try {
    const rows = db.prepare(`
      SELECT LOWER(COALESCE(i.state, '')) AS state
        FROM issue i
        JOIN issue_group g ON g.issue_id = i.issue_id AND g.group_name = 'row'
        LEFT JOIN issue_tombstone t ON t.issue_id = i.issue_id
       WHERE t.issue_id IS NULL AND COALESCE(i.is_pull_request, 0) = 0
    `).all() as Array<{ state: string }>
    const out = { open: 0, closed: 0, total: rows.length }
    for (const row of rows) {
      if (row.state === 'open') out.open += 1
      if (row.state === 'closed') out.closed += 1
    }
    return out
  } finally { db.close() }
}

const wsRoot = makeWorkspace('gate-12-')
try {
  const key = { workspaceRoot: wsRoot, backend: 'gitee', repoIdentity: 'acme/demo' }
  const before: any = await recordIssueRows(Object.assign({ rows: firstRows, atomic: true }, key))
  check(before && before.ok === true, 'D1 首屏那一批票行能写进真库', before)
  const countsBefore: any = await readSnapshotCounts(key)
  check(countsBefore && countsBefore.closed === 0 && countsBefore.open === 2,
    'D2 只写首屏那批：库里 open=2、closed=0（关闭池那张票还不在库里）', countsBefore)
  const after: any = await recordIssueRows(Object.assign({ rows: refreshRows, atomic: true }, key))
  check(after && after.ok === true, 'D3 刷新那一批票行能写进真库', after)
  const countsAfter: any = await readSnapshotCounts(key)
  const dbPath = defaultSnapshotDbPath(wsRoot, 'gitee')
  const indep = closedCountIndependently(dbPath)
  check(countsAfter && countsAfter.closed === 1, 'D4 写完刷新那批：顶部「已关闭」数的来源 counts.closed 从 0 变 1', countsAfter)
  check(countsAfter && countsAfter.closed === indep.closed, 'D5 counts.closed 与另写一条 SQL 独立数出来的关闭行数一致', { counts: countsAfter && countsAfter.closed, indep })
  check(countsAfter && countsAfter.open === 2 && indep.open === 2, 'D6 counts.open 没被关闭票带涨（关闭票不进开放统计）', { counts: countsAfter, indep })
  check(countsAfter && countsAfter.total === 3, 'D7 库里的总行数是 3（开放两张 + 补进来的关闭一张）', countsAfter)
} finally {
  try { await closeSnapshotLibraries() } catch (e) { /* 关库失败不影响判据 */ }
  try { rmSync(wsRoot, { recursive: true, force: true }) } catch (e) { /* 临时目录清了就行 */ }
}

// ── E 失败档可定位、不炸整轮；没有 listPage 成员就一次都不发 ─────────────────────
const mark3 = listPageCalls.length
phase.closedMode = 'throw'
let threw = false
try {
  await composer.composeSnapshot('gitee', REF, CTX, { force: true, closedPool: true, previousSnapshot: second.snapshot })
} catch (e) { threw = true }
const evE1 = lastEvent()
check(threw === false, 'E1 关闭池查询抛异常时整轮刷新不失败')
check(closedPoolCallsFrom(mark3).length === 1 && evE1.closedPoolQueries === 1, 'E2 抛异常的那一轮也只发一次，次数照样记进日志', { calls: closedPoolCallsFrom(mark3).length, ev: evE1 })
check(evE1.closedPoolError === 'thrown', 'E3 抛异常记 thrown（失败档能定位到是异常而不是远端拒答）', evE1.closedPoolError)
phase.closedMode = 'transport'
await composer.composeSnapshot('gitee', REF, CTX, { force: true, closedPool: true, previousSnapshot: second.snapshot })
const evE2 = lastEvent()
check(evE2.closedPoolError === 'transport', 'E4 远端拒答记它自己的 error.kind', evE2.closedPoolError)
check(evE2.closedPoolAdded === 0 && evE2.closedPoolRows === 0, 'E5 失败那一轮不补行（不拿半份回包充数）', evE2)

// G5：只认后端实例上有没有这个成员，不 import 能力登记表。
const legacyTracker = {
  list: async () => ({ ok: true, data: [issue('5', { state: 'OPEN' })] }),
  listSubIssues: async () => ({ ok: true, data: { items: [] } }),
}
const wsEvents2: any[] = []
const composer2 = createSnapshotComposer({ get: () => legacyTracker }, { logCtx: { fire: (_l: string, ev: string, f: any) => { if (ev === 'snapshot.workingSet') wsEvents2.push(f || {}) } } })
const legacy: any = await composer2.composeSnapshot('github', REF, CTX, { closedPool: true })
check(legacy && wsEvents2.length === 1 && wsEvents2[0].closedPoolQueries === 0 && wsEvents2[0].closedPoolError === '',
  'E6 后端实例没有 listPage 成员时一次都不发，也不记失败档', wsEvents2[0])
const src = readFileSync(path.join(ROOT, 'src/host/tracker/snapshotWorkingSet.ts'), 'utf8')
check(src.indexOf('capability-answer') < 0 && src.indexOf('capability-declaration') < 0,
  'E7 组装层没有 import 能力登记表（G5 红线）')

// ── G 翻页取尽与触顶标不全（#7 评审 F7） ──────────────────────────────────────
phase.open = [issue('1', { state: 'OPEN' })]
phase.closedMode = 'ok'
phase.closedPages = [
  [issue('71', { state: 'CLOSED' })],
  [issue('72', { state: 'CLOSED' })],
]
const markG = listPageCalls.length
const g1: any = await composer.composeSnapshot('gitee', REF, CTX, { force: true, closedPool: true, previousSnapshot: null })
const evG1 = lastEvent()
const gCalls = closedPoolCallsFrom(markG)
check(gCalls.length === 2 && gCalls[1] && gCalls[1].opts.cursor === '2',
  'G1 一页没取尽就按游标翻下一页（实得 ' + gCalls.length + ' 次）', gCalls.map((c) => c.opts))
check(evG1.closedPoolQueries === 2 && evG1.closedPoolRows === 2, 'G2 日志把两页的次数与条数如实累加', evG1)
check(evG1.closedPoolIncomplete === false && g1.snapshot.deck.partial === false,
  'G3 取尽时标「已取全」，deck.partial 不因此置真', { incomplete: evG1.closedPoolIncomplete, partial: g1.snapshot.deck.partial })

// 五页上限：远端一直说有下一页，翻到第 5 页就停，并如实标不全。
phase.closedPages = null
phase.closedAlwaysMore = true
phase.closed = [issue('73', { state: 'CLOSED' })]
const markG2 = listPageCalls.length
const g2: any = await composer.composeSnapshot('gitee', REF, CTX, { force: true, closedPool: true, previousSnapshot: null })
const evG2 = lastEvent()
check(closedPoolCallsFrom(markG2).length === 5 && evG2.closedPoolQueries === 5,
  'G4 远端一直有下一页时翻到 5 页上限就停（实得 ' + closedPoolCallsFrom(markG2).length + ' 次）', evG2)
check(evG2.closedPoolIncomplete === true, 'G5 触顶时日志如实标不全', evG2)
check(evG2.closedPoolRows === 5 && g2.snapshot.deck.partial === true,
  'G6 每页取到一张且结果标「不完全」，deck.partial 置真（界面能看出这份数据不全）', { rows: evG2.closedPoolRows, partial: g2.snapshot.deck.partial })
phase.closedAlwaysMore = false

// 只在第一页就失败时，也算没取全（不许把它当成「关闭票就这么多」）。
phase.closedMode = 'transport'
const markG3 = listPageCalls.length
const g3: any = await composer.composeSnapshot('gitee', REF, CTX, { force: true, closedPool: true, previousSnapshot: null })
const evG3 = lastEvent()
check(closedPoolCallsFrom(markG3).length === 1 && evG3.closedPoolIncomplete === true && g3.snapshot.deck.partial === true,
  'G7 第一页就失败时不重试、但如实标不全，deck.partial 置真', { calls: closedPoolCallsFrom(markG3).length, ev: evG3 })
phase.closedMode = 'ok'
phase.closed = []

// ── F 接线静态判据 ───────────────────────────────────────────────────────────
function codeOnly(text: string): string {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}
const refreshSrc = codeOnly(readFileSync(path.join(ROOT, 'src/refresh/rooms/host/session-refresh-schedule.ts'), 'utf8'))
const closedPoolTrue = refreshSrc.split('closedPool: true').length - 1
check(closedPoolTrue === 2, 'F1 刷新调度主路径与回退路径各传一处 closedPool: true', closedPoolTrue)
const firstScreenSrc = codeOnly(readFileSync(path.join(ROOT, 'src/refresh/rooms/host/session-snapshot-cache.ts'), 'utf8'))
check(firstScreenSrc.indexOf('closedPool') < 0, 'F2 首屏缓存不传 closedPool（首屏取数次数锁死）')

printGateResult(GATE, total, failed)
process.exit(failed ? 1 : 0)
