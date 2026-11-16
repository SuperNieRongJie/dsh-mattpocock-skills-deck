/**
 * src/tracker/rooms/gitee/repo/permissions.ts —— 把仓库定义里的 permission 折成 push / triage
 *
 * Gitee 的 Project 定义里 permission 是一个对象，典型形状 `{pull, push, admin}`。
 * 契约只要两个布尔：能不能写（push）、能不能分诊（triage）。Gitee 没有单独的 triage 位，
 * 所以按「能写的人当然能分诊」折：triage = push || admin。
 *
 * 问不出来就如实失败：permission 缺失、不是对象、或者三个布尔一个都没有时，
 * 不拿 false/false 冒充「没有权限」——那会让用户以为自己的权限被撤了。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { RepositoryRef } from '../../../contract/entities.js'
import type { OpResult, RepoPermissions } from '../../../contract/results.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestRepo } from '../requests.js'
import { parseJsonSafe } from '../support/json.js'
import { repoRefId } from '../support/repo-ref.js'
import { emitReadDegraded } from '../support/read-log.js'
import { isBag } from '../issues/shared.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

function boolOf(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

export async function getRepoPermissions(ctx: GiteeCtx, repo: Repo): Promise<OpResult<RepoPermissions>> {
  const startedAt = Date.now()
  const refId = repoRefId(repo)
  if (!refId) {
    emitReadDegraded(ctx as OpContext, 'permissions', 'permissions:repo-ref', Date.now() - startedAt)
    return failGitee('repo.refId missing', 'getRepoPermissions: repo.refId missing', '')
  }
  try {
    const res = await requestRepo(ctx, refId, GITEE_READ_TIMEOUT_MS)
    if (res.code !== 0) {
      emitReadDegraded(ctx as OpContext, 'permissions', 'permissions:transport', Date.now() - startedAt)
      return failGitee(res, String(res.stderr || '') || String(res.stdout || '') || 'getRepoPermissions 没问出来', res, ctx)
    }
    const parsed = parseJsonSafe(res.stdout)
    if (!isBag(parsed)) {
      emitReadDegraded(ctx as OpContext, 'permissions', 'permissions:json', Date.now() - startedAt)
      return failGitee(res, 'getRepoPermissions: 回包不是 JSON 对象', res, ctx)
    }
    const permission = parsed['permission']
    if (!isBag(permission)) {
      emitReadDegraded(ctx as OpContext, 'permissions', 'permissions:no-fields', Date.now() - startedAt)
      return failGitee(res, 'getRepoPermissions: 回包里没有 permission 对象，问不出权限', res, ctx)
    }
    const push = boolOf(permission['push'])
    const admin = boolOf(permission['admin'])
    if (push === null && admin === null) {
      emitReadDegraded(ctx as OpContext, 'permissions', 'permissions:no-fields', Date.now() - startedAt)
      return failGitee(res, 'getRepoPermissions: permission 里既没有 push 也没有 admin，问不出权限', res, ctx)
    }
    const canPush = push === true || admin === true
    return { ok: true, data: { push: canPush, triage: canPush } }
  } catch (err) {
    emitReadDegraded(ctx as OpContext, 'permissions', 'permissions:transport', Date.now() - startedAt)
    return failGitee(err, 'getRepoPermissions: 调用失败', err, ctx)
  }
}

export default getRepoPermissions
