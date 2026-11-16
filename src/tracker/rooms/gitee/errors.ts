/**
 * src/tracker/rooms/gitee/errors.ts —— Gitee 房自己的「前置扩展」错误规则
 *
 * 全仓只有一张有序规则表（src/tracker/kernel/error-rules.ts），它先判；判不出档时
 * 才轮到这里的房间表。所以这里的条目必须只写「通用表判不出来的 Gitee 措辞」，
 * 每条都带一个 example，门禁会拿 example 逐条自证：这条真能判成它声明的档。
 *
 * 八档 ErrorKind 是契约固定的（env/auth/rate-limit/conflict/unsupported/not-found/network/parse），
 * 这里只挑档，不新增档。
 *
 * 失败一律用 kernel/preflight.ts 的 fail(kind, message, raw) 构造，不抛异常：
 * 抛异常会让调用链多一层人人写法不同的 try/catch，而契约本来就把失败表达成返回值。
 */
import { ERROR_KIND } from '../../contract/vocabulary.js'
import type { ErrorKind } from '../../contract/identity.js'
import type { TrackerError } from '../../contract/results.js'
import { HINT_UNRECOGNIZED, HINT_UNSUPPORTED, fail } from '../../kernel/preflight.js'
import type { ClassifyCtx } from '../../kernel/preflight.js'
import { emitPassthrough, factsFromError, judgeFactsDetailed } from '../../kernel/error-rules.js'
import type { ErrorRule } from '../../kernel/error-rules.js'

const KIND_VALUES: ReadonlySet<string> = new Set(Object.values(ERROR_KIND))

export interface GiteeVerdict {
  kind: ErrorKind
  /** true 表示规则表没认出来、只是给了兜底档；调用方要据此把原文如实说成「没认出来」。 */
  fallback: boolean
}

/**
 * Gitee 侧可识别的措辞。
 *
 * 两条都挑自 CLI 的认证失败原文：Gitee 的 CLI 在没配置令牌时说的是「未登录」，
 * 或者「access token is required」。这两句都不在通用表里（通用表认英文 auth/unauthorized 一类），
 * 所以放在房间表；它们指向的结论都是「先登录」，不是「仓库不存在」。
 */
export const GITEE_ERROR_RULES: readonly ErrorRule[] = [
  {
    kind: ERROR_KIND.AUTH as ErrorKind,
    layer: 'phrase',
    pattern: /未登录|请先登录/,
    example: { text: 'gitee: 未登录，请先执行 gitee auth login' },
    note: 'Gitee CLI 在本地没有登录态时用中文提示「未登录」；这属于认证问题，不能显示成仓库不存在。',
  },
  {
    kind: ERROR_KIND.AUTH as ErrorKind,
    layer: 'phrase',
    pattern: /access token is required/i,
    example: { text: '{"message":"access token is required"}' },
    note: 'Open API 对匿名请求回的固定英文，通用表没有这一句；同样是认证问题。',
  },
]

function carriedKind(err: unknown): ErrorKind | null {
  if (!err || typeof err !== 'object') return null
  const bag = err as Record<string, unknown>
  const direct = bag['kind']
  if (typeof direct === 'string' && KIND_VALUES.has(direct)) return direct as ErrorKind
  const inner = bag['error']
  if (inner && typeof inner === 'object') {
    const nested = (inner as Record<string, unknown>)['kind']
    if (typeof nested === 'string' && KIND_VALUES.has(nested)) return nested as ErrorKind
  }
  return null
}

/**
 * 判档入口。
 *
 * 顺序不能反：先看错误里有没有已经判好的 kind（上游或进程包装层可能已经判过，
 * 再判一次会把一个明确的档位重新猜成兜底档），再走通用表 + 房间表。
 */
export function classifyGiteeError(err: unknown, ctx?: ClassifyCtx): GiteeVerdict {
  const carried = carriedKind(err)
  if (carried) {
    emitPassthrough(ctx, carried)
    return { kind: carried, fallback: false }
  }
  const judged = judgeFactsDetailed(factsFromError(err), GITEE_ERROR_RULES, ctx)
  return { kind: judged.kind, fallback: judged.fallback }
}

/** 档位对应的用户提示：没认出来就直说没认出来，unsupported 用统一的「本房做不到」话术。 */
export function hintFor(verdict: GiteeVerdict, nativeMessage: string): string {
  if (verdict.fallback) return HINT_UNRECOGNIZED
  if (verdict.kind === ERROR_KIND.UNSUPPORTED) return HINT_UNSUPPORTED
  return nativeMessage
}

/** 把任意失败收成契约里的失败结果。raw 缺省时用错误本身，保留现场。 */
export function failGitee(
  err: unknown,
  nativeMessage: string,
  raw?: unknown,
  ctx?: ClassifyCtx,
): { ok: false; error: TrackerError } {
  const verdict = classifyGiteeError(err, ctx)
  // 入参不合规这类「还没动手就拒绝」的失败由调用点自己写 TRACKER_ERROR_STAGE.INPUT_REFUSED：
  // 那一段只许出现在 fail(...) 的调用点上，转一手会把阶段标注变成形参转发（门禁 A1 判红）。
  return fail(verdict.kind, hintFor(verdict, nativeMessage), arguments.length > 2 ? raw : err)
}

export default classifyGiteeError
