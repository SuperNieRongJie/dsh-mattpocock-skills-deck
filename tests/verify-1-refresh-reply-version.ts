/**
 * tests/verify-1-refresh-reply-version.ts —— 手动刷新的回包要带上「写库之后」的库版本（#1）
 *
 * 治的是什么：手动刷新（wf.refresh）把新数据装进本地快照、也写进了库，但回包里没有库版本。
 * 客户端于是只记「发请求之前」读到的那一版，列表按「工作区|版本号」复用旧画面 —— 症状就是
 * 「按了刷新，票状态、筛选、统计一起不动」，要等下一拍自动探测把版本推上去才变。
 * 这一扇门禁从宿主刷新电话路的入口打进去（createSessionRefresh.handleRefresh，与 #1869 同一入口），
 * 用真 SQLite 与真临时工作区要求：
 *   一、刷新成功时回包顶层的 version 就是写库之后的合并版本（与回放读到的版本一致）；
 *   二、这一趟没写库（库层降级 readonly / legacy-writer、没接库口）时回包 version 是 null，不拿 0 冒充；
 *   三、客户端那边「装上一份快照之后该记哪一版」只有一个出口 installedSnapshotVersionOf：
 *      回包带非负整数版本就以它为准，没有才退回发请求前读到的那一版；0 是合法版本。
 *
 * 为什么还要静态断言两处接线：宿主的两条组包支路、客户端的装快照那一段没有天然的类型约束，
 * 门禁跑得再绿也测不到「有人把 version 那一行删了，而单测仍传自己的替身」。
 *
 * 用法：node --import ./scripts/ts-hook.mts tests/verify-1-refresh-reply-version.ts
 */
// 门禁归属: src/refresh/rooms/host/session-refresh-schedule.ts
// 门禁归属: src/refresh/rooms/client/snapshot-version-sync.ts
// 门禁归属: src/refresh/rooms/client/snapshot-sync.ts

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printGateResult } from './lib/gate-result.ts'
import { createSessionRefresh } from '../src/refresh/rooms/host/session-refresh-schedule.ts'
import { recordIssueRows, readSnapshotReplay, closeSnapshotLibraries } from '../src/refresh/rooms/host/snapshot-library.ts'
import { createSnapshotEnvelope } from '../src/host/snapshotEnvelope.ts'
import { installedSnapshotVersionOf } from '../src/refresh/rooms/client/snapshot-version-sync.ts'
import type { Issue, RepositoryRef } from '../src/tracker/contract/entities.ts'

const GATE = 'verify-1-refresh-reply-version'
const ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REF: RepositoryRef = { backend: 'github', refId: 'acme/widgets', name: 'widgets', url: 'https://github.com/acme/widgets' }
const quiet = { fire: () => {}, isEnabled: () => false }
let total = 0
let failed = 0

function check(cond: unknown, message: string, detail?: unknown): void {
  total += 1
  if (cond) { console.log('PASS ' + message); return }
  failed += 1
  console.log('FAIL ' + message + (detail === undefined ? '' : '（实得 ' + JSON.stringify(detail) + '）'))
}

function issue(input: Partial<Issue> & { key: string; title: string }): Issue {
  const base: Issue = {
    key: input.key,
    effortId: input.effortId || '',
    type: input.type || 'issue',
    title: input.title,
    state: input.state || 'open',
    body: input.body || '',
    url: 'https://github.com/acme/widgets/issues/' + input.key,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    closedAt: null,
    parentKey: input.parentKey === undefined ? null : input.parentKey,
  }
  return Object.assign(base, input)
}

/** 一轮列表结果。换过标题的那一轮必须带更晚的更新时间（#1931 的行组按更新时间判覆盖）。 */
function rowsWith(prefix: string, updatedAt?: string): Issue[] {
  const extra = updatedAt ? { updatedAt } : {}
  return [
    issue({ key: '100', type: 'map', title: prefix + '容器', ...extra } as any),
    issue({ key: '5', title: prefix + '子票', parentKey: '100', ...extra } as any),
  ]
}

function depsFor(cwd: string, rows: Issue[], library: any) {
  const table = new Map<string, any>()
  const adopt = (snap: unknown, c: string) => { table.set(c, { ts: Date.now(), snapshot: snap, error: null, cwd: c }); return snap }
  const tracker = {
    list: async () => ({ ok: true, data: rows.map((r) => Object.assign({}, r)) }),
    counts: async () => ({ ok: false, error: { kind: 'unsupported' } }),
    getCurrentUser: async () => ({ ok: true, data: { login: 'octo' } }),
  }
  const reg = { modules: () => [], describe: () => REF, get: () => tracker }
  const base: any = {
    canonicalKey: async () => cwd,
    selectEarly: async () => ({ backendId: 'github', rev: 1 }),
    isComposerSelection: () => true,
    getTrackerRegistry: async () => reg,
    getPlatform: async () => ({}),
    ctx: { get: () => null },
    getCache: (c: string) => table.get(String(c)) || { ts: 0, snapshot: null, error: null, cwd: String(c) },
    setCache: (v: any) => { if (v && v.cwd) table.set(String(v.cwd), v) },
    upcaseSnapStates: (s: any) => s,
    computeLevels: () => ({ byNumber: {}, byKey: {} }),
    groupTickets: (tickets: any[]) => ({
      total: tickets.length,
      open: tickets.filter((t) => String(t.state).toUpperCase() !== 'CLOSED').length,
      closed: tickets.filter((t) => String(t.state).toUpperCase() === 'CLOSED').length,
      frontier: 0, claimed: 0, blocked: 0, levels: [], levelOf: {},
    }),
    getRepoRoot: async () => cwd,
    getRepoKey: async () => ({ owner: 'acme', name: 'widgets' }),
    readDiskCache: async () => null,
    writeDiskCache: () => {},
    adoptSnapshot: adopt,
    detectionExec: async () => ({ ok: false }),
    resetGhCache: () => {},
    getGhPath: () => '',
    getGhLastError: () => '',
    errText: (e: any) => String((e && e.message) || e),
    logCtx: quiet,
    envelope: createSnapshotEnvelope({ getGhPath: () => '', getGhLastError: () => '', adoptSnapshot: adopt, logCtx: quiet }),
  }
  base.getSnapshotLibrary = () => library
  return base
}

async function replayOf(cwd: string): Promise<any> {
  return await readSnapshotReplay({ workspaceRoot: cwd, backend: 'github', repoIdentity: REF.refId, repo: REF })
}

function sourceOf(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

async function main(): Promise<void> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'verify-1-refresh-reply-version-'))
  try {
    mkdirSync(path.join(dir, 'docs', 'agents'), { recursive: true })
    writeFileSync(path.join(dir, 'docs', 'agents', 'workspace.yaml'), 'name: gate-1-refresh-reply-version')

    // ── A. 正常刷新：写库之后的版本随回包交给客户端 ──────────────────────────────────
    const seed = await recordIssueRows({ workspaceRoot: dir, backend: 'github', repoIdentity: REF.refId, rows: rowsWith('旧'), atomic: true })
    check(seed.ok === true && seed.rows === 2 && typeof seed.mergeVersion === 'number', 'A1 旧的一轮先写进库（两行、带合并版本）', seed)
    const seedVersion = Number(seed.mergeVersion)
    closeSnapshotLibraries()

    const library = { recordIssueRows: async (input: any) => await recordIssueRows(input) }
    const good = createSessionRefresh(depsFor(dir, rowsWith('新', '2026-11-02T00:00:00Z'), library) as any)
    const reply: any = await good.handleRefresh({ cwd: dir })
    check(reply && reply.ok === true, 'A2 刷新成功', reply && reply.error)
    check(Object.prototype.hasOwnProperty.call(reply || {}, 'version'), 'A3 回包顶层带 version 这一格', reply)
    check(typeof reply.version === 'number' && Number.isInteger(reply.version) && reply.version >= 0,
      'A4 回包的 version 是非负整数（不是 null、也不是字符串）', reply.version)
    check(reply.version === seedVersion + 1, 'A5 回包版本就是写库之后的合并版本（只前进一格）', [seedVersion, reply.version])
    const replay1 = await replayOf(dir)
    check(replay1 !== null && reply.version === replay1.mergeVersion, 'A6 回包版本与库里回放读到的版本一致', replay1 && replay1.mergeVersion)

    // ── B. 库层降级（只读）：这一趟没写库，回包不许报一个假版本 ──────────────────────
    const readonlyLib = { recordIssueRows: async () => ({ ok: false, rows: 0, mergeVersion: null, reason: 'readonly' }) }
    const readonlyRefresh = createSessionRefresh(depsFor(dir, rowsWith('只读', '2026-11-03T00:00:00Z'), readonlyLib) as any)
    const readonlyReply: any = await readonlyRefresh.handleRefresh({ cwd: dir })
    check(readonlyReply && readonlyReply.ok === true, 'B1 库层只读时刷新仍成功（既有降级口径）', readonlyReply && readonlyReply.error)
    check(readonlyReply.version === null, 'B2 没写库的一趟回包 version 是 null（不拿 0 冒充）', readonlyReply.version)

    // ── C. 库层降级（旧租约）：同上，别把「没写成」报成新版本 ────────────────────────
    const leaseLib = { recordIssueRows: async () => ({ ok: false, rows: 0, mergeVersion: null, reason: 'legacy-writer' }) }
    const leaseRefresh = createSessionRefresh(depsFor(dir, rowsWith('旧租约', '2026-11-04T00:00:00Z'), leaseLib) as any)
    const leaseReply: any = await leaseRefresh.handleRefresh({ cwd: dir })
    check(leaseReply && leaseReply.ok === true, 'C1 旧租约挡住本地写时刷新仍成功', leaseReply && leaseReply.error)
    check(leaseReply.version === null, 'C2 被挡住的一趟回包 version 是 null', leaseReply.version)

    // ── D. 没接库口：刷新照旧成功，回包也没有版本 ──────────────────────────────────
    const noLib = depsFor(dir, rowsWith('无库口', '2026-11-05T00:00:00Z'), null)
    delete noLib.getSnapshotLibrary
    const noLibReply: any = await createSessionRefresh(noLib as any).handleRefresh({ cwd: dir })
    check(noLibReply && noLibReply.ok === true, 'D1 没接库口时刷新仍成功（不改旧语义）', noLibReply && noLibReply.error)
    check(noLibReply.version === null, 'D2 没接库口时回包 version 是 null', noLibReply.version)

    // ── E. 客户端出口：装上一份快照之后记哪一版 ────────────────────────────────────
    check(installedSnapshotVersionOf({ version: 7 }, 3) === 7, 'E1 回包带版本时以回包为准（不是请求前那一版）', installedSnapshotVersionOf({ version: 7 }, 3))
    check(installedSnapshotVersionOf({ version: 7 }, null) === 7, 'E2 请求前读不到版本也能记回包版本', installedSnapshotVersionOf({ version: 7 }, null))
    check(installedSnapshotVersionOf({ version: 0 }, null) === 0, 'E3 第 0 版是合法版本（不满足判据会被当成「没有」）', installedSnapshotVersionOf({ version: 0 }, null))
    check(installedSnapshotVersionOf({}, 3) === 3, 'E4 回包没带版本时退回请求前那一版', installedSnapshotVersionOf({}, 3))
    check(installedSnapshotVersionOf({ version: -1 }, 3) === 3, 'E5 负数版本不算数，退回请求前那一版', installedSnapshotVersionOf({ version: -1 }, 3))
    check(installedSnapshotVersionOf({ version: 7.5 }, 3) === 3, 'E6 非整数版本不算数，退回请求前那一版', installedSnapshotVersionOf({ version: 7.5 }, 3))
    check(installedSnapshotVersionOf({ version: '7' }, 3) === 3, 'E7 字符串版本不算数（不悄悄转成数字）', installedSnapshotVersionOf({ version: '7' }, 3))

    // ── F. 接线：删掉任何一处，上面那些真库断言都测不到 ──────────────────────────────
    const scheduleSrc = sourceOf('src/refresh/rooms/host/session-refresh-schedule.ts')
    check(/version:\s*replyVersion\b/.test(scheduleSrc), 'F1 宿主主支路的组包把写库版本填进了回包')
    check(/version:\s*replyVersion2\b/.test(scheduleSrc), 'F2 宿主回退支路的组包也填了写库版本')
    const syncSrc = sourceOf('src/refresh/rooms/client/snapshot-sync.ts')
    check(/installedSnapshotVersionOf\(snap, null\)/.test(syncSrc), 'F3 客户端装上整份快照后先问回包版本')
    const versionSrc = sourceOf('src/refresh/rooms/client/snapshot-version-sync.ts')
    check(/installedSnapshotVersionOf\(snap, seen\)/.test(versionSrc), 'F4 整份取数那条路与装快照共用同一个版本判据')
  } finally {
    closeSnapshotLibraries()
    rmSync(dir, { recursive: true, force: true })
  }
  printGateResult(GATE, total, failed)
}

main().catch((e) => {
  console.log('FAIL 门禁异常退出：' + ((e && e.stack) || e))
  printGateResult(GATE, total, failed + 1)
  process.exitCode = 1
})
