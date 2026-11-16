/**
 * src/tracker/rooms/gitee/support/repo-ref.ts —— 从仓库引用里取 Gitee 需要的三个领域值
 *
 * Gitee 的接口路径有两种形状：仓库级 `/repos/{owner}/{repo}/...`，以及建票、改票用的
 * owner 级 `/repos/{owner}/issues...`。所以房间内部反复要用「整条 refId」「owner」「repo 名」
 * 三个值。取值规则写在一处，是为了保证建票与改票永远把同一段字符串当作 repo 交给远端，
 * 不会一处用 refId、另一处用最后一段。
 *
 * 这里只做字符串切分，不判断仓库存不存在、不发请求。
 */
import type { RepositoryRef } from '../../../contract/entities.js'

export type RepoLike = Partial<RepositoryRef> | null | undefined

/**
 * 契约里的仓库标识：refId 是 `owner/repo` 两段。
 * 缺失、空串、只有一段都算「这次调用没拿到可用的仓库标识」，由调用方如实失败。
 */
export function repoRefId(repo: RepoLike): string {
  if (!repo || typeof repo !== 'object') return ''
  const raw = (repo as { refId?: unknown }).refId
  return typeof raw === 'string' ? raw.trim() : ''
}

/** refId 的第一段是 owner；没有第一段就回空串。 */
export function ownerOf(refId: string): string {
  const parts = String(refId || '').split('/').filter((p) => p !== '')
  return parts.length > 0 ? parts[0] : ''
}

/** refId 的第二段是仓库名；Gitee 的 owner 级路径要在正文里带这一段。 */
export function repoNameOf(refId: string): string {
  const parts = String(refId || '').split('/').filter((p) => p !== '')
  return parts.length > 1 ? parts[1] : ''
}

/** 是不是一条能用的 `owner/repo`：两段都非空。 */
export function looksLikeRepoRef(refId: string): boolean {
  return ownerOf(refId) !== '' && repoNameOf(refId) !== ''
}

export default { repoRefId, ownerOf, repoNameOf, looksLikeRepoRef }
