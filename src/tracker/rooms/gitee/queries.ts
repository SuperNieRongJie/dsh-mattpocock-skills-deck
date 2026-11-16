/**
 * src/tracker/rooms/gitee/queries.ts —— Gitee REST 路径的唯一拼装处
 *
 * 全房间只允许在这个文件里拼路径与查询串。理由有两条：
 *   1. 端点采样门禁只看房间根目录的直接子文件，路径散到别处就采不到样本；
 *   2. 路径是「哪个端点」的唯一表征，读的人想核对某个操作打的是哪个端点，只看这一份就够。
 *
 * 约定（不要改）：
 *   · 路径从 `repos/...` 开始写，**不带 /v5**：CLI 的 api_prefix 默认已经是
 *     `https://gitee.com/api/v5`，再写一段就成了 /v5/v5；
 *   · {number} 位置一律放票自己的字符串标识（形如 I8A2BC），不是数字 id；
 *   · 每段都单独做 encodeURIComponent，owner/repo 里的特殊字符不会把路径拆错；
 *   · 查询串只在这里拼，requests.ts 只收「已经拼好的查询串」或领域值。
 */
import { ownerOf, repoNameOf } from './support/repo-ref.js'

/** 仓库级前缀：`repos/{owner}/{repo}`。 */
export function repoPath(refId: string): string {
  const owner = ownerOf(refId)
  const repo = repoNameOf(refId)
  return 'repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo)
}

/** 票集合路径；query 为空时不留一个孤零零的问号。 */
export function issuesPath(refId: string, query = ''): string {
  const base = repoPath(refId) + '/issues'
  return query ? base + '?' + query : base
}

/** 单张票路径，{number} 放票的字符串标识。 */
export function issuePath(refId: string, key: string): string {
  return repoPath(refId) + '/issues/' + encodeURIComponent(String(key))
}

/** 评论集合路径（GET 读评论、POST 写评论共用）。 */
export function commentsPath(refId: string, key: string): string {
  return issuePath(refId, key) + '/comments'
}

/** owner 级建票路径：`repos/{owner}/issues`，仓库名放在请求正文里。 */
export function ownerIssuesPath(refId: string): string {
  return 'repos/' + encodeURIComponent(ownerOf(refId)) + '/issues'
}

/** owner 级改票路径：`repos/{owner}/issues/{number}`，仓库名放在请求正文里。 */
export function ownerIssuePath(refId: string, key: string): string {
  return ownerIssuesPath(refId) + '/' + encodeURIComponent(String(key))
}

/** 标签集合路径（Gitee 的标签端点不支持分页参数，一次读完）。 */
export function labelsPath(refId: string): string {
  return repoPath(refId) + '/labels'
}

/** 单个标签路径；original_name 是改名前那一份名字。 */
export function labelPath(refId: string, originalName: string): string {
  return labelsPath(refId) + '/' + encodeURIComponent(String(originalName))
}

/** 里程碑集合路径；第一批只用它把票面上的里程碑读出来，不做里程碑写操作。 */
export function milestonesPath(refId: string, query = ''): string {
  const base = repoPath(refId) + '/milestones'
  return query ? base + '?' + query : base
}

/** 当前登录人。 */
export function currentUserPath(): string {
  return 'user'
}

/** 建仓库（个人命名空间下）。 */
export function userReposPath(): string {
  return 'user/repos'
}

export default {
  repoPath,
  issuesPath,
  issuePath,
  commentsPath,
  ownerIssuesPath,
  ownerIssuePath,
  labelsPath,
  labelPath,
  milestonesPath,
  currentUserPath,
  userReposPath,
}
