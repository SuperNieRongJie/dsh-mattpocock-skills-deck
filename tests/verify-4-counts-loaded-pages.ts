/**
 * tests/verify-4-counts-loaded-pages.ts —— 顶部统计要把「已加载的翻页行」数进去（#4）
 *
 * 守什么：
 *   A 合计算法的口径：快照池里的行与按需翻页取回的行按票身份去重后一起数，池子里那份的状态为准；
 *     身份取不到时宁可多算一行，也不把已经画在屏幕上的票漏掉。
 *   B 接线层的优先级：有库计数（deck.counts）时仍用库那一份（#1887 的全仓真数不被翻页行抬高）；
 *     拿不到库计数时用「池子 + 翻页行」，并照旧标 complete=false（界面据此说「已知 N 张（未取全）」）。
 *   C 视图模型的联动：翻页行一变，counts 与 rows 一起变且 counts 只重算一次；改筛选不动 counts；
 *     同一版本 adopt 复用、翻页行没变时一个切片都不重算；端口不给 countsOf 时沿用建帧那一份。
 *   D 静态接线：接线层的 countsOf 端口、视图模型的 rebuildCounts 调用点、列表行池拼翻页行都真的在；
 *     并留一条反证，证明「没把翻页行交进去」的写法会被这道判据当场抓住。
 *
 * 为什么要有这一扇：2026-11-25 的真机上，同一屏同时写着「2 已关闭」「已知 2 张（未取全）」与
 *   「已加载 12 / 共 12」——行来自快照池 + 客户端翻页桶，数字却只从池子派生（#4 的票面有截图与代码链）。
 *
 * 跑法：node --import ./scripts/ts-hook.mts tests/verify-4-counts-loaded-pages.ts
 */
// 门禁归属: src/client/kernel/issue-pages.ts
// 门禁归属: src/client/kernel/deck-view-binding.ts
// 门禁归属: src/client/kernel/deck-view-model.ts
// 门禁归属: src/client/views/ListTab.ts

import { printGateResult } from './lib/gate-result.ts'
import { sourceText } from './lib/source-text.ts'
import { issueRowsCountOf } from '../src/client/kernel/issue-pages.ts'
import { createDeckView, deckFiltersOf, deckReadingOf } from '../src/client/kernel/deck-view-model.ts'
import { deckCountsOf, kpiCountsOf } from '../src/client/kernel/store-derived.ts'

const GATE = 'verify-4-counts-loaded-pages'

let total = 0
let failed = 0
function check(cond: unknown, message: string, detail?: unknown): void {
  total += 1
  if (cond) { console.log('PASS ' + message); return }
  failed += 1
  console.log('FAIL ' + message + (detail === undefined ? '' : '（实得 ' + JSON.stringify(detail) + '）'))
}

/** 票身份是「工作单元 + 编号」的字符串；这一扇用编号代替，装到 globalThis 上给翻页片去重用。 */
const g: any = globalThis
function installIdentity(): void { g.idOf = function (x: any): string { return String((x && x.key) || '') } }
function uninstallIdentity(): void { delete g.idOf }

/** 一行票（界面形状）：状态大写，默认开放。 */
function trow(key: string, state?: string, extra?: any): any {
  return Object.assign({ key: key, number: Number(key), type: 'issue', state: state || 'OPEN', assignees: [] }, extra || {})
}

/** 十张已关闭的历史票：就是截图里按需翻回来的那一屏，与快照池零重叠。 */
function historyRows(n: number): any[] {
  const out: any[] = []
  for (let i = 1; i <= n; i++) out.push(trow(String(100 + i), 'CLOSED'))
  return out
}

/** 库计数的形状（#1887）：六个数字 + 完整度；known 表示「库只认得这么多」，complete=false。 */
function libCounts(): any {
  return { total: 11, open: 9, closed: 2, takeable: 8, blocked: 1, claimed: 1, completeness: 'known', complete: false }
}

/** 与生产接线同一把尺子：工单口径、库计数、KPI 派生都用真函数，只有占用数与 BUG/诊断是假的。 */
function scopeOf(): any {
  return {
    ticketRowsOf: function (arr: any): any[] { return (Array.isArray(arr) ? arr : []).filter(function (x: any): boolean { return !(x && x.isPullRequest === true) }) },
    occCount: function (): number { return 0 },
    deckCountsOf: deckCountsOf,
    bugCount: function (): number { return 0 },
    triageCount: function (): number { return 0 },
    kpiCountsOf: kpiCountsOf,
  }
}

async function main(): Promise<void> {
  installIdentity()
  g.issueRowsCountOf = issueRowsCountOf
  const binding: any = await import('../src/client/kernel/deck-view-binding.ts')
  const scope: any = scopeOf()

  // ------------------------------------------------------------------ A 合计算法的口径
  {
    const pool: any[] = [trow('1', 'CLOSED'), trow('2', 'CLOSED')]
    const pages: any[] = historyRows(10)
    const a1: any = issueRowsCountOf(pool, [])
    check(a1.open === 0 && a1.closed === 2 && a1.total === 2, 'A1 只有池子时照旧数池子（开放 0 / 已关闭 2）', a1)
    const a2: any = issueRowsCountOf([], pages)
    check(a2.closed === 10 && a2.total === 10, 'A2 只有翻页行时也数进去（不再当成 0）', a2)
    const a3: any = issueRowsCountOf(pool, pages)
    check(a3.open === 0 && a3.closed === 12 && a3.total === 12, 'A3 池子 + 翻页行 = 12（截图那一屏的真实下界）', a3)
    const dup: any = issueRowsCountOf([trow('7', 'OPEN')], [trow('7', 'CLOSED')])
    check(dup.total === 1 && dup.open === 1 && dup.closed === 0, 'A4 同一张票只算一次，池子那份的状态为准', dup)
    const mixed: any = issueRowsCountOf([], [trow('8', 'CLOSED'), trow('9'), trow('10', 'OPEN')])
    check(mixed.open === 2 && mixed.closed === 1 && mixed.total === 3, 'A5 开放/已关闭按 state 分（只认大写 CLOSED）', mixed)
    const bad: any = issueRowsCountOf(undefined, null)
    check(bad.open === 0 && bad.closed === 0 && bad.total === 0, 'A6 坏输入（undefined/null）当空，不死', bad)
    const holes: any[] = [null, undefined, trow('11', 'CLOSED')]
    check(issueRowsCountOf(holes, []).closed === 1, 'A7 数组里夹着空行时跳过空行、其余照数')
    uninstallIdentity()
    const noId: any = issueRowsCountOf([trow('7', 'OPEN')], [trow('7', 'CLOSED')])
    check(noId.total === 2, 'A8 身份取不到时不去重：宁可多算一行，也不把画出来的票漏掉', noId)
    installIdentity()
  }

  // ------------------------------------------------------------------ B 接线层：库计数优先，没库才算合并数
  {
    const proj: any = { generatedMs: 1, issues: [trow('21', 'CLOSED'), trow('22', 'CLOSED')], maps: [] }
    const b1: any = binding.deckCountsFor(scope, proj, historyRows(10))
    check(b1.open === 0 && b1.closed === 12 && b1.total === 12, 'B1 没有库计数时，总数与已关闭都用池子 + 翻页行 = 12', b1)
    check(b1.complete === false && b1.counts === null && b1.kpi && b1.kpi.closed === 12 && b1.kpi.complete === false, 'B2 没有库计数时如实标「未取全」，KPI 与列表同源', { complete: b1.complete, kpi: b1.kpi })
    const b3: any = binding.deckCountsFor(scope, proj)
    check(b3.closed === 2 && b3.total === 2, 'B3 不给翻页行时与改动前一致（只数池子）', b3)
    const withLib: any = { generatedMs: 1, issues: [trow('21', 'CLOSED'), trow('22', 'CLOSED')], maps: [], deck: { counts: libCounts() } }
    const b4: any = binding.deckCountsFor(scope, withLib, historyRows(10))
    check(b4.open === 9 && b4.closed === 2 && b4.total === 11, 'B4 有库计数时仍用库那一份（全仓真数不被翻页行抬高）', b4)
    check(b4.complete === false && b4.kpi && b4.kpi.closed === 2, 'B5 库计数与 KPI 同源：完整度与数字都跟随库', { complete: b4.complete, kpi: b4.kpi })
    const prProj: any = { issues: [trow('31', 'OPEN', { isPullRequest: true }), trow('32', 'CLOSED')], maps: [] }
    const b6: any = binding.deckCountsFor(scope, prProj, historyRows(10))
    check(b6.open === 0 && b6.closed === 11 && b6.total === 11, 'B6 拉取请求不算工单（沿用 ticketRowsOf 的口径）', b6)
    const dupProj: any = { issues: [trow('41', 'CLOSED')], maps: [] }
    check(binding.deckCountsFor(scope, dupProj, [trow('41', 'CLOSED')]).total === 1, 'B7 池子里已有的那一张不会因为也在翻页行里被数两遍')
  }

  // ------------------------------------------------------------------ C 视图模型：翻页行一变，counts 与 rows 一起变
  {
    const proj: any = { generatedMs: 1, issues: [trow('21', 'CLOSED'), trow('22', 'CLOSED')], maps: [] }
    const frame: any = { key: 'ws|7', version: 7, projection: proj, counts: binding.deckCountsFor(scope, proj), readout: { version: 7, generatedMs: 1, workRouteTable: null } }
    const port: any = {
      countsOf: function (f: any, reading: any): any { return binding.deckCountsFor(scope, f.projection, reading.pageRows) },
      rowsSource: function (f: any, reading: any): any[] { return (((f && f.projection) || {}).issues || []).concat(Array.isArray(reading.pageRows) ? reading.pageRows : []) },
      effortOf: function (): string { return '' },
      occupiedOf: function (): boolean { return false },
      labelNamesOf: function (): string[] { return [] },
    }
    const view: any = createDeckView({ frame: frame, filters: deckFiltersOf({ stateFilter: 'closed' }), reading: deckReadingOf({}), ports: port })
    check(view.slice('counts').closed === 2, 'C1 构造时只数池子（这时还没有翻页行）', view.slice('counts'))
    const hits: any = { counts: 0 }
    view.subscribe('counts', function (): void { hits.counts += 1 })
    const v0: number = view.versionOf('counts')
    const pages: any[] = historyRows(10)
    const r1: any = view.command('setPageRows', pages)
    check(r1.changed.indexOf('counts') >= 0 && r1.changed.indexOf('rows') >= 0, 'C2 翻页行变了，counts 与 rows 都在「这一趟变了」里', r1.changed)
    check(view.slice('counts').closed === 12 && view.slice('rows').visible.length === 12, 'C3 统计与列表同步变成 12（同一屏不再两个数）', { counts: view.slice('counts'), visible: view.slice('rows').visible.length })
    check(hits.counts === 1 && view.versionOf('counts') === v0 + 1, 'C4 counts 只重算一次（订阅者只收到一次）', { hits: hits, version: view.versionOf('counts') })
    const r2: any = view.command('setPageRows', pages)
    check(r2.changed.length === 0 && view.versionOf('counts') === v0 + 1, 'C5 同一份翻页行再喂一遍，一个切片都不动', r2.changed)
    const v1: number = view.versionOf('counts')
    view.command('setStateFilter', 'all')
    check(view.versionOf('counts') === v1 && view.slice('counts').closed === 12, 'C6 改筛选不动 counts（数字不随筛选口径漂移）')
    const adoptSame: any = view.adopt({ frame: frame })
    check(adoptSame.outcome === 'reused' && view.versionOf('counts') === v1, 'C7 同一版本 adopt 复用，不重算 counts', adoptSame)
    const adoptPages: any = view.adopt({ frame: frame, reading: deckReadingOf({ pageRows: historyRows(10) }) })
    check(adoptPages.outcome === 'updated' && adoptPages.changed.indexOf('counts') >= 0 && view.slice('counts').closed === 12, 'C8 会话存储带回另一份翻页行时，adopt 也把 counts 带上', adoptPages)
    const plain: any = createDeckView({ frame: frame, filters: deckFiltersOf({}), reading: deckReadingOf({}) })
    check(plain.slice('counts') === frame.counts, 'C9 端口不给 countsOf 时沿用建帧那一份（其它屏与旧构造不受影响）')
  }

  // ------------------------------------------------------------------ D 静态接线
  {
    const bindingSrc: string = sourceText('src/client/kernel/deck-view-binding.ts')
    const modelSrc: string = sourceText('src/client/kernel/deck-view-model.ts')
    const pagesSrc: string = sourceText('src/client/kernel/issue-pages.ts')
    const listSrc: string = sourceText('src/client/views/ListTab.ts')
    const judgeMerge = function (src: string): boolean { return src.indexOf('issueRowsCountOf(rows, pageRows)') >= 0 }
    check(judgeMerge(bindingSrc), 'D1 接线层把翻页行交给了合计算法')
    check(bindingSrc.indexOf('countsOf: function (f: any, reading: any)') >= 0 && bindingSrc.indexOf('deckCountsFor(scope, f.projection') >= 0, 'D2 countsOf 端口从阅读态取 pageRows 交给 deckCountsFor')
    check((modelSrc.match(/rebuildCounts\(/g) || []).length >= 3, 'D3 视图模型在建帧、命令、adopt 三处都重算 counts', (modelSrc.match(/rebuildCounts\(/g) || []).length)
    check(pagesSrc.indexOf('export const issueRowsCountOf = function') >= 0, 'D4 合计算法只有一处，住在翻页片里（与行池同源）')
    check(listSrc.indexOf("issuePageRowsOf(st, 'list')") >= 0, 'D5 列表行池确实会拼上按需翻页的行（所以数字必须跟着它们）')
    check(!judgeMerge('deckCountsFor(scope, projection, pageRows)') && !judgeMerge('issueRowsCountOf(rows)'), 'D6 反证：没把翻页行交进去的写法会被这道判据当场抓住')
  }
}

main().then(function (): void {
  console.log('')
  if (failed) console.log('FAIL：' + total + ' 条断言里有失败')
  else console.log('OK：' + total + ' 条断言全部通过')
  printGateResult(GATE, total, failed)
  process.exit(failed ? 1 : 0)
}, function (err: any): void {
  console.error('门禁脚本自身出错：', err)
  printGateResult(GATE, total, failed + 1)
  process.exit(1)
})
