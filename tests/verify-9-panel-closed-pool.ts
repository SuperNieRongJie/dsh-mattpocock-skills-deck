// tests/verify-9-panel-closed-pool.ts —— 票 #9 门禁：远端关闭的票在「已关闭」与「全部」档都看得见
// 门禁归属: src/host/tracker/snapshotWorkingSet.ts
// 门禁归属: src/host/tracker/snapshot.ts
//
// 判据（票 #9 的四条验收，逐条对应下面的断言组）：
// ① 远端关闭一张票后刷新，它出现在「已关闭」里，而不是只从开放列表消失（A 组）；
// ② 一个开放票都没有的仓库，「全部」档显示已取回的关闭票，而不是「暂无」（B 组）；
// ③ 首屏取数仍只拉开放票：不新增首屏查询（每轮 list 恰好一次且筛选是开放票；listPage 至多一次、
//   且只会是 #1796 就有的「已关闭地图容器页」那一趟，见 A5/A6/b5/b6/c3/c4）；
// ④ 「关闭票不进顶部统计」的口径不被顺手改掉：补回来的行状态是已关闭、组装器不往 deck 上挂 counts（A7/D5）。
//
// 为什么按刷新路的样子驱动：Gitee 的「上一份快照」与「写库」只在刷新这条路（wf.refresh）成立 ——
//   首屏 wf.snapshot 对 Gitee 既不回放库也不写库（见 src/refresh/rooms/host/session-snapshot-cache.ts:202
//   的 libraryBackend 名单）。所以本门禁把上一趟的快照原样当 previousSnapshot 传回 composeSnapshot，
//   这就是验收里说的「刷新」。
// 界面那一侧不渲染：按 src/client/views/ListTab.ts 的分拣口径在这里复算（:208 取快照 issues、
//   :264-270 状态 'CLOSED' 的行进已关闭、:461-462 空档写「暂无」、:466-473 「全部」档的折叠入口
//   只在关闭行非空时出现），客户端代码一行不改。
//
// 跑法：node --import ./scripts/ts-hook.mts tests/verify-9-panel-closed-pool.ts
import { printGateResult } from './lib/gate-result.ts'

const GATE = 'verify-9-panel-closed-pool'
let total = 0
let failed = 0
function check(ok: boolean, msg: string, detail?: unknown): void {
  total += 1
  if (ok) { console.log('  PASS ' + msg); return }
  failed += 1
  console.log('  FAIL ' + msg + (detail === undefined ? '' : ' — ' + String(detail).slice(0, 300)))
}

const { createSnapshotComposer } = await import('../src/host/tracker/snapshot.ts')
const { assembleWorkingSet } = await import('../src/host/tracker/snapshotWorkingSet.ts')

/** 一行票：形状与各后端归一层的产出一致（宿主组装层只读这几格）。 */
function issue(key: string, extra?: Record<string, any>): any {
  return Object.assign({
    key, number: Number(key), effortId: '', type: 'issue', title: '票 ' + key, state: 'OPEN',
    body: '正文 ' + key, url: 'https://example.test/issues/' + key, parentKey: null,
    labels: [], assignees: [], blockedBy: [], isPullRequest: false,
  }, extra || {})
}

const REF = { refId: 'acme/demo', owner: 'acme', name: 'demo' }
const CTX = { cwd: 'D:\\ws' }

// 假后端：这一趟开放池里有哪些票、这一趟列表全不全，由 phase 决定；调用次数与筛选如实记下来给验收③用。
let phase: any = { rows: [] }
const calls = { list: 0, listPage: 0, listSubIssues: 0 }
const listFilters: any[] = []
const listPageFilters: any[] = []
const tracker = {
  list: async (_ref: any, filter: any) => {
    calls.list += 1
    listFilters.push(filter || {})
    const res: any = { ok: true, data: (phase.rows || []).map(function (r: any) { return Object.assign({}, r) }) }
    if (phase.truncated === true) res.truncated = true
    if (phase.fallback) res.fallback = phase.fallback
    return res
  },
  listPage: async (_ref: any, filter: any) => {
    calls.listPage += 1
    listPageFilters.push(filter || {})
    return { ok: true, data: { items: [] } }
  },
  listSubIssues: async () => { calls.listSubIssues += 1; return { ok: true, data: { items: [] } } },
}
// 常驻日志在这一份门禁里当探针用：snapshot.workingSet 的 carriedClosedRows 是「这一趟补回来几张」的唯一读数，
// 光看行看不见「补的」与「上一趟原样留下来的」有什么区别。
const wsEvents: any[] = []
const logCtx: any = {
  fire: function (lvl: string, ev: string, fields: any) {
    if (ev === 'snapshot.workingSet') wsEvents.push(fields || {})
  },
}
const composer = createSnapshotComposer({ get: () => tracker }, { logCtx })

/**
 * 按 src/client/views/ListTab.ts 的分拣口径复算一份快照在列表页签上的样子。
 * 不渲染、不改客户端：这里只回答「已关闭档里有没有它」「全部档底部那个折叠入口会不会出现」。
 */
function panelViewOf(snap: any, stateFilter: 'all' | 'open' | 'closed'): any {
  const issues: any[] = (Array.isArray(snap && snap.issues) ? snap.issues : []).filter(function (r: any) {
    return !(r && r.isPullRequest === true)
  })
  const closedRows: any[] = issues.filter(function (r: any) { return r && r.state === 'CLOSED' })
  const openRows: any[] = issues.filter(function (r: any) { return r && r.state !== 'CLOSED' })
  const showOpen: boolean = stateFilter !== 'closed'
  return {
    openRows,
    openKeys: openRows.map(function (r: any) { return String(r.key) }),
    closedRows,
    closedKeys: closedRows.map(function (r: any) { return String(r.key) }),
    foldShown: stateFilter === 'all' && closedRows.length > 0,
    openEmpty: showOpen && openRows.length === 0,
  }
}
function previewOf(items: any[], extra?: any): void { phase = Object.assign({ rows: items }, extra || {}) }
/** 这一轮只允许两种远端调用：一次开放票列表（必有），至多一次已关闭地图容器页（#1796 既有）。 */
function remoteCallsQuiet(round: number): boolean {
  const filter = listFilters[round - 1]
  const listOk: boolean = calls.list === round && !!filter && filter.state === 'open'
  const pageOk: boolean = calls.listPage <= round
  const pageFiltersOk: boolean = listPageFilters.every(function (f: any) {
    return f && f.state === 'closed' && Array.isArray(f.labels) && f.labels.length === 1 && f.labels[0] === 'wayfinder:map'
  })
  return listOk && pageOk && pageFiltersOk
}

// ---- 第一趟（冷启动）：开放池里有两张开着的票，没有任何已关闭行 ----
previewOf([issue('101'), issue('102')])
const r1: any = await composer.composeSnapshot('github', REF, CTX, { force: true })
check(r1 && r1.ok === true && !!r1.snapshot, '0 第一趟照常出快照', r1 && r1.ok)
check(panelViewOf(r1.snapshot, 'closed').closedKeys.length === 0, '0 第一趟没有已关闭行（起点是干净的）')
check(calls.list === 1 && listFilters[0] && listFilters[0].state === 'open', '0 首屏只调一次 list，且筛选是开放票（验收③的起点）', JSON.stringify(listFilters))
check(wsEvents.length === 1 && wsEvents[0].carriedClosedRows === 0, '0 第一趟 carriedClosedRows 是 0（没有上一份快照可补）', wsEvents[0] && wsEvents[0].carriedClosedRows)

// ---- A 组：远端把 101 关掉，刷新以后它出现在「已关闭」里（验收①）----
previewOf([issue('102')])
const r2: any = await composer.composeSnapshot('github', REF, CTX, { force: true, previousSnapshot: r1.snapshot })
const v2closed = panelViewOf(r2.snapshot, 'closed')
check(v2closed.closedKeys.indexOf('101') !== -1, 'A1 远端关掉的票在刷新后出现在「已关闭」里（不再只从开放列表消失）', v2closed.closedKeys.join(','))
const row101 = (v2closed.closedRows || []).filter(function (r: any) { return String(r.key) === '101' })[0]
check(!!row101 && row101.number === 101 && !!row101.title, 'A2 补回来的行能画：票号与标题都在', row101 && JSON.stringify({ n: row101.number, t: row101.title }))
const allIds2 = (r2.snapshot.issues || []).map(function (r: any) { return String(r.key) })
check(allIds2.filter(function (k: string) { return k === '101' }).length === 1, 'A3 同一张票只出现一行（按身份去重）', allIds2.join(','))
const v2all = panelViewOf(r2.snapshot, 'all')
check(v2all.openKeys.join(',') === '102', 'A4 还开着的 102 不受影响，没有被打成关闭', v2all.openKeys.join(','))
check(remoteCallsQuiet(2), 'A5 这一轮远端调用没多：list 仍是一次开放票，listPage 仍只有既有的已关闭地图容器页（验收③）', JSON.stringify(calls) + ' ' + JSON.stringify(listFilters))
check(wsEvents.length === 2 && wsEvents[1].carriedClosedRows === 1, 'A6 这一轮只补回一张（carriedClosedRows=1），没有把池里还在的 102 也当成关掉的补一遍', wsEvents[1] && wsEvents[1].carriedClosedRows)
check(!!r2.snapshot.deck && r2.snapshot.deck.counts === undefined, 'A7 组装器不往 deck 上挂 counts：关闭票没有借这个口子进顶部统计（验收④）', r2.snapshot.deck && JSON.stringify(Object.keys(r2.snapshot.deck)))

// ---- B 组：一个开放票都没有的仓库，「全部」档显示已取回的关闭票（验收②）----
previewOf([])
const r3: any = await composer.composeSnapshot('github', REF, CTX, { force: true, previousSnapshot: r2.snapshot })
const v3all = panelViewOf(r3.snapshot, 'all')
const v3closed = panelViewOf(r3.snapshot, 'closed')
check(v3all.openKeys.length === 0, 'B1 这一趟开放池是空的（0 开放票仓库）', v3all.openKeys.join(','))
check(v3closed.closedKeys.indexOf('101') !== -1, 'B2 上一轮补回来的关闭票这一轮还在（不是闪一次的假象）', v3closed.closedKeys.join(','))
check(v3closed.closedKeys.indexOf('102') !== -1, 'B3 这一轮刚关掉的 102 也进了关闭行', v3closed.closedKeys.join(','))
check(v3all.foldShown === true && v3all.closedRows.length === 2, 'B4 「全部」档出现关闭票折叠入口，里面有 2 张已取回的关闭票（不是「暂无」）', JSON.stringify({ fold: v3all.foldShown, n: v3all.closedRows.length }))
check(remoteCallsQuiet(3), 'B5 第三轮远端调用没多（list 一次开放票；listPage 仍只有既有的已关闭地图容器页）', JSON.stringify(calls))
check((r3.snapshot.issues || []).length === 2, 'B6 关闭行没有重复堆积（两张票各一行）', (r3.snapshot.issues || []).length)

// ---- C 组：列表被截断时不许把缺行当成关闭（缺行也可能只是没取到）----
previewOf([], { truncated: true })
const r4: any = await composer.composeSnapshot('github', REF, CTX, { force: true, previousSnapshot: r2.snapshot })
const v4all = panelViewOf(r4.snapshot, 'all')
check(wsEvents.length === 4 && wsEvents[3].carriedClosedRows === 0, 'C1 截断的那一轮一张都不补（carriedClosedRows=0）', wsEvents[3] && wsEvents[3].carriedClosedRows)
check(v4all.openKeys.indexOf('102') !== -1 && v4all.closedKeys.length === 1 && v4all.closedKeys[0] === '101',
  'C2 截断时上一份快照的行按原状态留下（102 仍是开放、101 仍是已关闭），没有被这一趟重新盖章', JSON.stringify({ open: v4all.openKeys, closed: v4all.closedKeys }))
check(remoteCallsQuiet(4), 'C3 截断的那一轮远端调用也没多（不会为了救急多发一趟已关闭页）', JSON.stringify(calls))

// 列表掉到 REST 通道（降级）与截断一样算来源不全：缺行同样不能判成关闭。
previewOf([], { fallback: 'rest' })
const r5: any = await composer.composeSnapshot('github', REF, CTX, { force: true, previousSnapshot: r2.snapshot })
check(r5 && r5.ok === true && wsEvents.length === 5 && wsEvents[4].carriedClosedRows === 0,
  'C4 列表降级到 REST 的那一轮也不补（carriedClosedRows=0，来源不全的两种情形都拦住）', JSON.stringify({ ok: r5 && r5.ok, n: wsEvents[4] && wsEvents[4].carriedClosedRows }))

// ---- D 组：补行的边界（直接调工作集，逐条盯住「什么不补、补成什么形状」）----
const prevSnap = {
  maps: [{ key: '200', number: 200, effortId: '', type: 'map', title: '上一趟还开着的地图', state: 'OPEN', body: '', tickets: [] }],
  issues: [
    issue('101', { state: 'CLOSED', labels: ['bug'], url: 'https://example.test/issues/101' }),
    issue('102', { parentKey: '200' }),
    issue('103', { isPullRequest: true }),
  ],
}
const d1: any = await assembleWorkingSet({ tracker: null, ref: REF as any, pool: [], previousSnapshot: prevSnap })
const d1ids = d1.rows.map(function (r: any) { return String(r.key) })
check(d1ids.indexOf('101') !== -1, 'D1 上一份快照里的顶票补回来了', d1ids.join(','))
const d200 = d1.rows.filter(function (r: any) { return String(r.key) === '200' })[0]
check(!!d200 && d200.type === 'map', 'D2 上一趟还开着、这一趟不在池里的地图容器也补回来，类型仍是容器（不变成普通票）', d200 && d200.type)
check(d1ids.indexOf('102') === -1, 'D3 挂在容器下的子票不补（容器关了以后后端本来就不提供它的子票，缺行证明不了它关了）', d1ids.join(','))
check(d1ids.indexOf('103') === -1, 'D4 拉取请求不补（它有自己的一趟增量抓取与页签）', d1ids.join(','))
const d101 = d1.rows.filter(function (r: any) { return String(r.key) === '101' })[0]
check(!!d101 && d101.state === 'CLOSED' && d101.body === '' && d101.isPullRequest === false,
  'D5 补回来的是薄行：状态已关闭、正文空串、不冒充拉取请求（验收④：不是开放行）', d101 && JSON.stringify({ s: d101.state, b: d101.body, p: d101.isPullRequest }))
check(!!d101 && d101.number === 101 && d101.title === '票 101' && d101.url === 'https://example.test/issues/101'
  && Array.isArray(d101.labels) && d101.labels[0] === 'bug',
  'D6 薄行保留能画的字段（票号、标题、链接、标签）', d101 && JSON.stringify({ n: d101.number, t: d101.title, l: d101.labels }))
check(d1.carriedClosedRows === 2, 'D7 carriedClosedRows 如实报出补回来几张（顶票与容器两张）', d1.carriedClosedRows)
const d2: any = await assembleWorkingSet({ tracker: null, ref: REF as any, pool: [], previousSnapshot: prevSnap, openListComplete: false })
check(d2.rows.length === 0 && d2.carriedClosedRows === 0, 'D8 调用方说来源不全（openListComplete=false）时一张都不补', d2.rows.length)
const d3: any = await assembleWorkingSet({ tracker: null, ref: REF as any, pool: [issue('101')], previousSnapshot: prevSnap })
const d3keys = d3.rows.map(function (r: any) { return String(r.key) })
check(d3keys.filter(function (k: string) { return k === '101' }).length === 1 && d3.rows[0].state === 'OPEN',
  'D9 池里已经有的票不重复补、也不改状态（开放池里那份为准）', JSON.stringify(d3.rows.map(function (r: any) { return [r.key, r.state] })))
const d4: any = await assembleWorkingSet({ tracker: null, ref: REF as any, pool: [] })
check(d4.rows.length === 0 && d4.carriedClosedRows === 0, 'D10 没给上一份快照时行为与从前一致（一张都不补）', d4.rows.length)

printGateResult(GATE, total, failed)
process.exit(failed ? 1 : 0)
