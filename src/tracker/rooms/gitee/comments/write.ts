/**
 * src/tracker/rooms/gitee/comments/write.ts —— 给一张票写评论
 *
 * Gitee 的评论端点回的是一条 Note（id、body、user、created_at…）。这里把它折成契约里的
 * Comment：作者取 user.login，时间取 created_at/updated_at，作者关系字段 Gitee 没有，
 * 如实填空串而不是编一个「成员」出来。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Comment, RepositoryRef } from '../../../contract/entities.js'
import type { OpResult } from '../../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { fail } from '../../../kernel/preflight.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestCommentCreate } from '../requests.js'
import { normalizeIssue } from '../model/normalize.js'
import { parseJsonSafe } from '../support/json.js'
import { repoRefId } from '../support/repo-ref.js'
import { isBag } from '../issues/shared.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

/** 写一条评论；正文为空直接拒掉，不把空评论发到远端。 */
export async function addComment(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  body: string,
  opCtx?: GiteeCtx,
): Promise<OpResult<Comment>> {
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'comment: repo.refId missing', '')
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) return fail(ERROR_KIND.PARSE, 'comment: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  const text = String(body == null ? '' : body)
  if (!text.trim()) return fail(ERROR_KIND.PARSE, 'comment: body required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  try {
    const res = await requestCommentCreate(effective, refId, wantedKey, text, GITEE_READ_TIMEOUT_MS)
    if (res.code !== 0) {
      return failGitee(res, String(res.stderr || '') || String(res.stdout || '') || 'comment: 写评论失败', res, effective)
    }
    const parsed = parseJsonSafe(res.stdout)
    if (!isBag(parsed)) {
      return failGitee(res, 'comment: 回包不是一个 JSON 对象', res, effective)
    }
    const one = normalizeIssue({ number: '0', body: '', comments: [parsed] })
    const comment = one.comments && one.comments[0]
    if (!comment) {
      return failGitee(res, 'comment: 回包里没有可用的评论内容', res, effective)
    }
    return { ok: true, data: comment }
  } catch (err) {
    return failGitee(err, 'comment: 写评论调用失败', err, effective)
  }
}

export default addComment
