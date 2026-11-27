/**
 * src/tracker/rooms/gitee/support/read-log.ts —— Gitee 房的两类诊断行：读不到时的退化，与正文兜底的整趟轨迹
 *
 * 为什么需要它：Gitee 房的很多判据（matches 的四层、预检的三关、翻页时撞上限）
 * 失败时只能退回一个「没有」。只回「没有」，用户与排查的人都不知道是哪一层没读到、
 * 是没权限、还是形状不对。这里统一写一行 read.degraded 事件，字段只有短枚举与毫秒数，
 * 不带正文、不带路径原文，避免把票面内容或令牌相关的东西写进日志。
 *
 * 事件名 read.degraded 与 preflight.gate 都是已登记事件（#108/#109），这里只复用，不改含义。
 *
 * 2026-11-27 #7 起，这个文件还收三行「正文兜底」的整趟轨迹（按需事件 #156～#158）：挂父票写没写下去、
 * 改阻塞关系写没写下去、读侧结构字段读到了什么又为什么退回正文。这三行同样是只收信号的短枚举与计数，
 * 照样不带票面正文与远端原文。
 */
import type { OpContext } from '../../../contract/contexts.js'
import { LIST_TRUNCATED_REASON } from '../../../contract/results.js'
import { debugOn, guardEmit, ms } from '../../../kernel/log-emit.js'

/** 会写读退化行的操作名；新增操作时一并补进来，门禁不认未知值。 */
export const READ_DEGRADED_OPS: readonly string[] = Object.freeze([
  'matches',
  'preflight',
  'list',
  'get',
  'create',
  'close',
  'reopen',
  'comment',
  'update',
  'setLabels',
  'setAssignees',
  'setParent',
  'counts',
  'listPage',
  'labels',
  'setLabelColors',
  'subIssues',
  'maps',
  'permissions',
  'currentUser',
  'repoKey',
  'initProject',
])

/** 每一步各自的退化原因，形如「操作:卡在哪一步」。 */
export const READ_DEGRADED_REASONS: readonly string[] = Object.freeze([
  'matches:fs-unavailable',
  'matches:git-config',
  'matches:tracker-doc',
  'matches:unknown',
  'preflight:gitee',
  'preflight:auth',
  'preflight:repo-view',
  'list:repo-ref',
  'list:transport',
  'list:json',
  'list:shape',
  LIST_TRUNCATED_REASON,
  'list:pull-request',
  'get:repo-ref',
  'get:transport',
  'get:json',
  'get:shape',
  'create:repo-ref',
  'create:transport',
  'create:json',
  'create:shape',
  'create:parent',
  'close:transport',
  'close:json',
  'close:shape',
  'reopen:transport',
  'reopen:json',
  'reopen:shape',
  'comment:repo-ref',
  'comment:transport',
  'comment:json',
  'comment:shape',
  'update:transport',
  'update:json',
  'update:shape',
  'update:milestone',
  'setLabels:transport',
  'setLabels:json',
  'setLabels:shape',
  'setAssignees:transport',
  'setAssignees:json',
  'setAssignees:shape',
  'setParent:transport',
  'setParent:json',
  'setParent:shape',
  'counts:repo-ref',
  'counts:transport',
  'counts:json',
  'counts:shape',
  'counts:cap',
  'listPage:repo-ref',
  'listPage:transport',
  'listPage:json',
  'listPage:shape',
  'listPage:total',
  'listPage:cursor',
  'labels:repo-ref',
  'labels:transport',
  'labels:json',
  'labels:shape',
  'setLabelColors:transport',
  'subIssues:repo-ref',
  'subIssues:transport',
  'subIssues:json',
  'subIssues:shape',
  'subIssues:page-fail',
  'subIssues:truncated',
  'subIssues:no-id',
  'maps:repo-ref',
  'maps:transport',
  'maps:json',
  'maps:shape',
  'maps:truncated',
  'permissions:repo-ref',
  'permissions:transport',
  'permissions:json',
  'permissions:no-fields',
  'currentUser:repo-ref',
  'currentUser:transport',
  'currentUser:json',
  'currentUser:shape',
  'repoKey:notfound',
  'repoKey:unknown',
  'initProject:remote',
  'initProject:local',
])

/** 预检三关的固定编号。 */
export const PREFLIGHT_GATES: readonly number[] = Object.freeze([1, 2, 3])

/** 每一关不过时记的原因；关号与原因一一对应，不要临时改。 */
export const PREFLIGHT_GATE_REASONS: Readonly<Record<number, string>> = Object.freeze({
  1: 'preflight:gitee',
  2: 'preflight:auth',
  3: 'preflight:repo-view',
})

export function isPreflightGate(gate: unknown): gate is number {
  return typeof gate === 'number' && PREFLIGHT_GATES.includes(gate)
}

type LoggerCtx = Pick<OpContext, 'isEnabled' | 'logEvent' | 'opId'>

/**
 * 写路径递进来的上下文形状：那三个格子都可能是缺的。
 *
 * 为什么单独留一格给三个新助手：写路径拿到的常常是 `Partial<OpContext> & Partial<BackendContext>`
 * （宿主兜底那条路、建票之后补挂父票那条路都是），要求必需就得在每个调用点写一次 cast，
 * 而 cast 会把「这些格子真不一定有」这件事实藏起来。缺席时 guardEmit 一律静默，行为不变。
 */
type MaybeLoggerCtx = Partial<Pick<OpContext, 'isEnabled' | 'logEvent' | 'opId'>> | null | undefined

/**
 * 记一行「这一步读不到，退回去了」。
 *
 * ctx 可能只有半截（matches 拿到的 handle 不保证带日志能力），guardEmit 会处理这种情形。
 */
export function emitReadDegraded(
  ctx: LoggerCtx | null | undefined,
  op: string,
  reason: string,
  latencyMs?: number,
): void {
  guardEmit(ctx, (c) => {
    c.logEvent('warn', 'read.degraded', {
      op: String(op || ''),
      reason: String(reason || ''),
      latencyMs: ms(latencyMs),
      opId: String(c.opId || ''),
    })
  })
}

/** 预检某一关放行时记一行，用来区分「走到第几关」与「第一关就没过」。 */
export function emitPreflightGatePass(
  ctx: LoggerCtx | null | undefined,
  gate: number,
  latencyMs?: number,
): void {
  if (!isPreflightGate(gate)) return
  guardEmit(ctx, (c) => {
    c.logEvent('info', 'preflight.gate', {
      gate,
      reason: 'ok',
      latencyMs: ms(latencyMs),
      opId: String(c.opId || ''),
    })
  })
}

/** 仓库解析走哪一层、成没成。tier 是层次名，ok 是结果。 */
export function emitRepoTier(
  ctx: LoggerCtx | null | undefined,
  tier: string,
  ok: boolean,
  startedAt?: number,
): void {
  guardEmit(ctx, (c) => {
    c.logEvent('info', 'repo.resolve.tier', {
      tier: String(tier || ''),
      ok: ok === true,
      latencyMs: ms(startedAt ? Date.now() - startedAt : 0),
    })
  })
}

/**
 * 写侧「挂父票」这一趟的轨迹（按需 #156 gitee.parent.fallback）。
 *
 * 为什么要有：挂父票要连做三件事——读父票拿数字 id、PATCH parent_id、写后读回；Gitee 的个人仓库
 * 会把 parent_id 静默忽略，于是这几步只有「读回里有没有这条父子」才是证据。只记读回结论的话，
 * 事后分不清停在哪一步：父票根本没找到、改票请求失败、改票回包成功但读不回、还是退了正文也失败。
 * 这几个取值就是那几条岔路，一个短枚举一格，不带票号与正文的原文。
 */
export type ParentFallbackTrip = {
  /** 哪一趟写：setParent 用户直接挂父票 / parentAfterCreate 建票之后补挂。 */
  op: string
  /** 被挂父票的那张票（票号原文）。 */
  key: string
  /** 打算挂到哪张父票。 */
  parent: string
  /**
   * 这一步的写请求回包成没成：setParent 指改 parent_id 那次 PATCH；
   * parentAfterCreate 指建票那次（票已经建成才会走到这里，所以起手就是 true）。
   */
  replyOk: boolean
  /** 写后读回：matched 父子在 / missing 读回来了但没有这条父子 / unread 整票没读回 / skipped 没走到读回。 */
  readBack: 'matched' | 'missing' | 'unread' | 'skipped'
  /** 正文兜底：none 没退 / body 退了且读回里有了 / body-failed 退了也没读回来。 */
  fallback: 'none' | 'body' | 'body-failed'
}

/** 记一行挂父票这一趟的轨迹；调试开关关着时连字段都不组装。 */
export function emitParentFallback(
  ctx: MaybeLoggerCtx,
  trip: ParentFallbackTrip,
  outcome: string,
  startedAt?: number,
): void {
  guardEmit(ctx as LoggerCtx | null | undefined, (c) => {
    c.logEvent('debug', 'gitee.parent.fallback', {
      op: String(trip.op || ''),
      key: trip.key,
      parent: String(trip.parent || ''),
      replyOk: trip.replyOk === true,
      readBack: String(trip.readBack || 'skipped'),
      fallback: String(trip.fallback || 'none'),
      outcome: String(outcome || ''),
      latencyMs: ms(startedAt ? Date.now() - startedAt : 0),
      opId: String(c.opId || ''),
    })
  }, () => debugOn(ctx))
}

/**
 * 写侧「改阻塞关系」这一趟的轨迹（按需 #157 gitee.blockedBy.fallback）。
 *
 * 为什么要有：改阻塞关系要读目标票、逐张读阻塞票拿标题、沿边做环检、写正文、写后读回核对集合；
 * 五步里任何一步读不回来都会中止（环检读不全就不敢写）。这几格回答「停在哪一步、读了几张、差哪几个」，
 * 只记计数与枚举，票面正文与远端原文一个字都不记。
 */
export type BlockedByFallbackTrip = {
  /** 这一趟要写成真阻塞的票有几张（入参去重后）。 */
  wanted: number
  /** 真读回并拿到标题的阻塞票有几张。 */
  blockersRead: number
  /** 环检沿边走过几个节点（含重复访问前的去重）。 */
  loopNodes: number
  /** 改票回包的退出码；没走到请求时为 0。 */
  replyCode: number
  /** 写后读回：match 集合对上了 / mismatch 对不上 / unread 单票没读回 / skipped 没走到读回。 */
  readBack: 'skipped' | 'match' | 'mismatch' | 'unread'
  /** 读回的小节比想写的少几个；没走到读回时为 0。 */
  missing: number
  /** 读回的小节比想写的多几个；没走到读回时为 0。 */
  extra: number
}

/** 记一行改阻塞关系这一趟的轨迹；调试开关关着时连字段都不组装。 */
export function emitBlockedByFallback(
  ctx: MaybeLoggerCtx,
  key: string,
  trip: BlockedByFallbackTrip,
  outcome: string,
  startedAt?: number,
): void {
  guardEmit(ctx as LoggerCtx | null | undefined, (c) => {
    c.logEvent('debug', 'gitee.blockedBy.fallback', {
      key: String(key || ''),
      wanted: trip.wanted,
      blockersRead: trip.blockersRead,
      loopNodes: trip.loopNodes,
      replyCode: trip.replyCode,
      readBack: String(trip.readBack || 'skipped'),
      missing: trip.missing,
      extra: trip.extra,
      outcome: String(outcome || ''),
      latencyMs: ms(startedAt ? Date.now() - startedAt : 0),
      opId: String(c.opId || ''),
    })
  }, () => debugOn(ctx))
}

/**
 * 读侧「结构字段读到什么、为什么退回正文」的轨迹（按需 #158 gitee.bodyFallback.read）。
 *
 * 为什么要有：Gitee 的父票与阻塞关系都可能只能从正文读，而正文那一段是兜底。只看回执分不清
 * 「远端给了结构字段、我们没有退回正文」与「结构字段是空的、这次确实按正文认的」，也分不清
 * 阻塞清单里哪几条是多读了一次单票才补上状态的。这几格就是那三件事：结构字段有没有值、
 * 父票最终按哪一侧认的、清单之外补读了几次、这一趟读全了没有。
 */
export function emitBodyFallbackRead(
  ctx: MaybeLoggerCtx,
  op: 'get' | 'deps',
  key: string,
  structural: 'parentKey' | 'parentUrl' | 'none',
  parentSource: 'structure' | 'body' | 'none',
  blockedByCount: number,
  singleReads: number,
  complete: boolean,
  startedAt?: number,
): void {
  guardEmit(ctx as LoggerCtx | null | undefined, (c) => {
    c.logEvent('debug', 'gitee.bodyFallback.read', {
      op,
      key: String(key || ''),
      structural,
      parentSource,
      blockedByCount,
      singleReads,
      complete: complete === true,
      latencyMs: ms(startedAt ? Date.now() - startedAt : 0),
      opId: String(c.opId || ''),
    })
  }, () => debugOn(ctx))
}

export default {
  emitReadDegraded,
  emitPreflightGatePass,
  emitRepoTier,
  emitParentFallback,
  emitBlockedByFallback,
  emitBodyFallbackRead,
}
