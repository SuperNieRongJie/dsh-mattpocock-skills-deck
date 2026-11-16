/**
 * src/tracker/rooms/gitee/repo/current-user.ts —— 当前登录人
 *
 * 只认 `GET /user` 回包里的 login 字段：Gitee 的 User 里 login 是账号名，name 是展示名，
 * 契约要的是账号名（其它房按它比对认领人）。回包里没有 login 就如实失败，
 * 不拿 name 顶上——那是两个不同的东西，混用会让「谁认领了这张票」判错。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { Actor } from '../../../contract/identity.js'
import type { ActorResult } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestCurrentUser } from '../requests.js'
import { parseJsonSafe } from '../support/json.js'
import { repoRefId } from '../support/repo-ref.js'
import { emitReadDegraded } from '../support/read-log.js'
import { isBag } from '../issues/shared.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

export async function getCurrentUser(ctx: GiteeCtx, repo: Repo): Promise<ActorResult> {
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) {
    emitReadDegraded(ctx as OpContext, 'currentUser', 'currentUser:repo-ref', Date.now() - startedAt)
    return failGitee('repo.refId missing', 'getCurrentUser: repo.refId missing', '')
  }
  try {
    const res = await requestCurrentUser(ctx, GITEE_READ_TIMEOUT_MS)
    if (res.code !== 0) {
      emitReadDegraded(ctx as OpContext, 'currentUser', 'currentUser:transport', Date.now() - startedAt)
      return failGitee(res, String(res.stderr || '') || String(res.stdout || '') || 'getCurrentUser 没问出来', res, ctx)
    }
    const parsed = parseJsonSafe(res.stdout)
    if (!isBag(parsed)) {
      emitReadDegraded(ctx as OpContext, 'currentUser', 'currentUser:json', Date.now() - startedAt)
      return failGitee(res, 'getCurrentUser: 回包不是 JSON 对象', res, ctx)
    }
    const login = String(parsed['login'] || '').trim()
    if (!login) {
      emitReadDegraded(ctx as OpContext, 'currentUser', 'currentUser:shape', Date.now() - startedAt)
      return failGitee(res, 'getCurrentUser: 回包里没有 login', res, ctx)
    }
    const actor: Actor = { login }
    const name = String(parsed['name'] || '').trim()
    if (name) actor.name = name
    const avatarUrl = String(parsed['avatar_url'] || '').trim()
    if (avatarUrl) actor.avatarUrl = avatarUrl
    return { ok: true, data: actor }
  } catch (err) {
    emitReadDegraded(ctx as OpContext, 'currentUser', 'currentUser:transport', Date.now() - startedAt)
    return failGitee(err, 'getCurrentUser: 调用失败', err, ctx)
  }
}

export default getCurrentUser
