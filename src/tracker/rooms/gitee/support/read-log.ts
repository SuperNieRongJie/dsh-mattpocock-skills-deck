/**
 * src/tracker/rooms/gitee/support/read-log.ts —— 读不到时留下的那一行诊断
 *
 * 为什么需要它：Gitee 房的很多判据（matches 的四层、预检的三关、翻页时撞上限）
 * 失败时只能退回一个「没有」。只回「没有」，用户与排查的人都不知道是哪一层没读到、
 * 是没权限、还是形状不对。这里统一写一行 read.degraded 事件，字段只有短枚举与毫秒数，
 * 不带正文、不带路径原文，避免把票面内容或令牌相关的东西写进日志。
 *
 * 事件名 read.degraded 与 preflight.gate 都是已登记事件（#108/#109），这里只复用，不改含义。
 */
import type { OpContext } from '../../../contract/contexts.js'
import { LIST_TRUNCATED_REASON } from '../../../contract/results.js'
import { guardEmit, ms } from '../../../kernel/log-emit.js'

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
      opId: String(c.opId || ''),
    })
  })
}

export default { emitReadDegraded, emitPreflightGatePass, emitRepoTier }
