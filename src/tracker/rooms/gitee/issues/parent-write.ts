/**
 * src/tracker/rooms/gitee/issues/parent-write.ts —— 挂父票，以及结构字段没生效时把关系写进正文
 *
 * 这几种写法的共同前提：Gitee 的 parent_id 在个人仓库会被静默忽略——请求回成功、读回来却没有父票。
 * 所以判定一律以写后读回为准；入参与回包都只当「我打算写什么」，不当证据。
 * 正文兜底的底稿只能来自一次成功的单票读回：回包里的正文可能不是全文，拿它整段盖回去会把票面正文写没。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { SetOpts } from '../../../contract/inputs.js'
import type { OpResult } from '../../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { failReason, outcomeOf } from '../../../kernel/log-emit.js'
import { fail } from '../../../kernel/preflight.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestIssueUpdate } from '../requests.js'
import { normalizeIssue } from '../model/normalize.js'
import { withParentLine } from '../model/parent-line.js'
import { repoNameOf, repoRefId } from '../support/repo-ref.js'
import { emitParentFallback } from '../support/read-log.js'
import type { ParentFallbackTrip } from '../support/read-log.js'
import { normalizePatchReply } from './patch-reply.js'
import { fetchIssueRaw } from './read.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
type Repo = Partial<RepositoryRef> | null | undefined

/** 把父票号翻成 parent_id 要的数字 id；父票读不到就回 null（调用方决定怎么报）。 */
export async function resolveParentId(opCtx: GiteeCtx, refId: string, parentKey: string): Promise<number | null> {
  const fetched = await fetchIssueRaw(opCtx, refId, parentKey)
  if (!fetched.ok) return null
  const id = fetched.bag['id']
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

/** 读回一张票并归一；读失败回 null（调用方据此区分「没读回来」与「读回来了、边不在」）。 */
async function readBackIssue(effective: GiteeCtx, refId: string, key: string): Promise<Issue | null> {
  try {
    const raw = await fetchIssueRaw(effective, refId, key)
    return raw.ok ? (normalizeIssue(raw.bag)) : null
  } catch (err) {
    return null
  }
}

/**
 * 结构字段没生效之后的正文兜底：把 `上级地图：#父票` 一行写进正文，再读回一次确认。
 *
 * 为什么非要再读一次：这次写正文的入参同样只是「我打算写什么」，不是「盘上有什么」。
 * 回包成功而读回里没有这条父子时，如实说「结构字段没生效、写进正文也没读回来」。
 */
async function writeParentBodyLine(
  effective: GiteeCtx,
  refId: string,
  issue: Issue,
  parent: string,
): Promise<{ ok: true; issue: Issue } | { ok: false; message: string }> {
  const body = withParentLine(issue.body, parent)
  let writeProblem = ''
  try {
    const res = await requestIssueUpdate(
      effective,
      refId,
      String(issue.key),
      { repo: repoNameOf(refId), body },
      GITEE_READ_TIMEOUT_MS,
    )
    const wrote = normalizePatchReply(res, '写父票正文失败')
    if (!wrote.ok) {
      const failure = wrote.result
      writeProblem = (failure.ok === false && failure.error ? String(failure.error.message || '') : '') || '远端没给原因'
    }
  } catch (err) {
    writeProblem = err instanceof Error ? err.message : String(err)
  }
  const back = await readBackIssue(effective, refId, String(issue.key))
  if (back && back.parentKey === parent) return { ok: true, issue: back }
  const reason = writeProblem
    ? ('写正文这一步就失败了：' + writeProblem)
    : '正文已经写了，但写后读回里没有这条父子'
  return { ok: false, message: '远端结构字段没生效，写进票正文也没读回来（来源：正文）：' + reason }
}

/**
 * 建票之后处理父票：先读回确认结构字段真的生效了，没生效才把关系写进正文。
 *
 * 票已经建成，所以这里的失败不是「票没建成」，而是「父子边没挂上」：照 GitHub 房 parentError
 * 的先例把原因记在票上，让工具层按部分成功报出来，同时保住票号。
 */
async function parentAfterCreateInner(
  effective: GiteeCtx,
  refId: string,
  key: string,
  parent: string,
  created: Issue,
  trip: ParentFallbackTrip,
): Promise<Issue> {
  const first = await readBackIssue(effective, refId, key)
  if (first && first.parentKey === parent) {
    trip.readBack = 'matched'
    return first
  }
  if (!first) {
    trip.readBack = 'unread'
    const unread = created as Issue & { parentError?: { kind: string; message: string } }
    unread.parentError = { kind: 'write', message: '远端结构字段没生效；单票没读回来，读不回整票就不敢改正文（来源：正文）' }
    return unread
  }
  trip.readBack = 'missing'
  const fallback = await writeParentBodyLine(effective, refId, first, parent)
  trip.fallback = fallback.ok ? 'body' : 'body-failed'
  if (fallback.ok) return fallback.issue
  const withNote = created as Issue & { parentError?: { kind: string; message: string } }
  withNote.parentError = { kind: 'write', message: fallback.message.slice(0, 300) }
  return withNote
}

/**
 * 建票之后补挂父票的那一趟，外面这一层只负责记整趟轨迹。
 *
 * 这一趟的结论不是 OpResult（票已经建成了，失败只挂在 parentError 上），所以档位由这里自己给：
 * 挂上了记 ok，没挂上记 fail:parent-error，事后只看日志就知道这张票的父子边到底有没有落地。
 */
export async function parentAfterCreate(
  effective: GiteeCtx,
  refId: string,
  key: string,
  parent: string,
  created: Issue,
): Promise<Issue> {
  const startedAt = Date.now()
  const trip: ParentFallbackTrip = {
    op: 'parentAfterCreate',
    key,
    parent,
    replyOk: true,
    readBack: 'skipped',
    fallback: 'none',
  }
  const result = await parentAfterCreateInner(effective, refId, key, parent, created, trip)
  const failed = !!(result as Issue & { parentError?: unknown }).parentError
  emitParentFallback(effective, trip, failed ? 'fail:parent-error' : 'ok', startedAt)
  return result
}

/**
 * 挂父票 / 拆父票。
 *
 * 挂：先把父票号读回来拿数字 id，再 PATCH parent_id。
 * 拆（parentKey === null）：Gitee 没有「移到根」的写法，如实回 unsupported。
 * 这一条是「形态不合」，不是「没做」：发一个含义不明的 0 有可能把票挂到不存在的父票上。
 */
async function setParentInner(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  parentKey: string | null,
  opts: SetOpts | undefined,
  opCtx: GiteeCtx | undefined,
  trip: ParentFallbackTrip,
): Promise<OpResult<Issue>> {
  void opts
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'setParent: repo.refId missing', '')
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) return fail(ERROR_KIND.PARSE, 'setParent: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  const parent = parentKey == null ? '' : String(parentKey).trim()
  if (!parent) {
    return failGitee(
      'parent clear unsupported',
      'setParent: Gitee 的改票正文没有把票移回根上的写法（parent_id 只收父票数字 id，没有 0 或空串的约定），拆父票做不到',
      '',
    )
  }
  try {
    const parentId = await resolveParentId(effective, refId, parent)
    if (parentId === null) {
      return failGitee('parent not found', 'setParent: 父票 ' + parent + ' 没找到（或没有权限看它）', parent)
    }
    const res = await requestIssueUpdate(
      effective,
      refId,
      wantedKey,
      { repo: repoNameOf(refId), parent_id: parentId },
      GITEE_READ_TIMEOUT_MS,
    )
    const reply = normalizePatchReply(res, 'setParent: gitee api 挂父票失败')
    trip.replyOk = reply.ok === true
    // #8：不拿入参补 parentKey —— 写动作的自述不是证据。parent_id 在个人仓库会被静默忽略，
    // 所以一律以写后读回为准；结构字段没生效就把关系写进正文，再读回确认。
    const first = await readBackIssue(effective, refId, wantedKey)
    if (first && first.parentKey === parent) {
      trip.readBack = 'matched'
      return { ok: true, data: first }
    }
    // 改票请求本身失败时如实回它的原因：这时去写正文，只会用一个次要失败盖住真实原因。
    if (!reply.ok) {
      trip.readBack = first ? 'missing' : 'unread'
      return reply.result
    }
    // 正文兜底只能拿「一次成功的单票读回」当底稿：改票回包里的正文可能缺失或不是全文，
    // 拿它整段盖回去会把票面正文写没，这是不可逆的内容损坏，所以读不回整票时一个字都不改正文。
    if (!first) {
      trip.readBack = 'unread'
      // 读回失败本身没留下具体错误对象，按「读不通远端」这一档带上原话：不能让上层回一句
      // 「没认出这次失败的原因」，那会让人误以为结构字段生效了。
      return failGitee({ kind: ERROR_KIND.NETWORK }, 'setParent: 远端结构字段没生效，单票也没读回来（读不通远端），读不回整票就不敢改正文（来源：正文）', parent)
    }
    trip.readBack = 'missing'
    const fallback = await writeParentBodyLine(effective, refId, first, parent)
    trip.fallback = fallback.ok ? 'body' : 'body-failed'
    if (fallback.ok) return { ok: true, data: fallback.issue }
    return failGitee(fallback.message, 'setParent: ' + fallback.message, parent)
  } catch (err) {
    return failGitee(err, 'setParent: gitee api 挂父票调用失败', err, effective)
  }
}

/**
 * 挂父票的对外入口：内层把这一趟的事实写在 trip 上，这里统一落一行日志再原样返回。
 *
 * 为什么不把 logEvent 摆进内层的每个早退分支：这一趟有七八处早退，各写一行既容易漏，
 * 也会让同一次操作在日志里出现两条。整趟一行、结论用档位收尾，读日志的人一眼看到停在哪。
 */
export async function setParent(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  parentKey: string | null,
  opts: SetOpts | undefined,
  opCtx?: GiteeCtx,
): Promise<OpResult<Issue>> {
  const startedAt = Date.now()
  const trip: ParentFallbackTrip = {
    op: 'setParent',
    key: String(key == null ? '' : key).trim(),
    parent: parentKey == null ? '' : String(parentKey).trim(),
    replyOk: false,
    readBack: 'skipped',
    fallback: 'none',
  }
  const result = await setParentInner(ctx, repo, key, parentKey, opts, opCtx, trip)
  const seen = outcomeOf(result)
  emitParentFallback(opCtx || ctx, trip, seen.ok ? 'ok' : failReason(seen.errKind), startedAt)
  return result
}