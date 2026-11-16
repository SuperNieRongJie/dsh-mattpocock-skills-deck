/**
 * src/tracker/rooms/gitee/requests.ts —— Gitee 远端端点的具名请求函数
 *
 * 一条规矩：这里只收领域值（refId、票号、查询串、要写的字段、超时毫秒数），
 * 路径一律由 queries.ts 拼，回包原样交回 {stdout, stderr, code}。
 * 这里不解析 JSON、不判档、不记业务日志——那样做会把「打哪个端点」与「怎么解释回包」
 * 搅成一份，改解释的人就得动请求层，端点采样也认不出这是哪一条。
 *
 * 超时不是裸数字：调用方从 shared/time-config 取值后作为最后一个参数传进来。
 * 时间参数放最后，是为了让每个函数读起来都是「对谁、做什么、等多久」。
 */
import type { BackendContext, OpContext } from '../../contract/contexts.js'
import { giteeClient } from './client.js'
import type { GiteeRunResult } from './client.js'
import {
  commentsPath,
  issuePath,
  issuesPath,
  labelPath,
  labelsPath,
  milestonesPath,
  ownerIssuePath,
  ownerIssuesPath,
  currentUserPath,
  repoPath,
  userReposPath,
} from './queries.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>

function clientOf(opCtx: GiteeCtx) {
  return giteeClient(opCtx)
}

/** 列出票：query 已由调用方拼好（分页、状态、标签、时间都在里面）。 */
export function requestIssueList(opCtx: GiteeCtx, refId: string, query: string, timeoutMs: number): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(issuesPath(refId, query), {}, { timeout: timeoutMs })
}

/** 读单张票。 */
export function requestIssueGet(opCtx: GiteeCtx, refId: string, key: string, timeoutMs: number): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(issuePath(refId, key), {}, { timeout: timeoutMs })
}

/** 读一页评论；query 里带分页与 since。 */
export function requestCommentList(opCtx: GiteeCtx, refId: string, key: string, query: string, timeoutMs: number): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(commentsPath(refId, key) + (query ? '?' + query : ''), {}, { timeout: timeoutMs })
}

/** 写一条评论。 */
export function requestCommentCreate(opCtx: GiteeCtx, refId: string, key: string, body: string, timeoutMs: number): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(commentsPath(refId, key), { method: 'POST', body: { body } }, { timeout: timeoutMs })
}

/** 建票要发的字段；仓库名也在这里，因为 Gitee 的建票路径是 owner 级。 */
export interface IssueCreateFields {
  repo: string
  title: string
  body?: string
  labels?: string
  assignee?: string
  parent_id?: number
}

/** 建票。 */
export function requestIssueCreate(opCtx: GiteeCtx, refId: string, fields: IssueCreateFields, timeoutMs: number): Promise<GiteeRunResult> {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') body[k] = v
  return clientOf(opCtx).api(ownerIssuesPath(refId), { method: 'POST', body }, { timeout: timeoutMs })
}

/** 改票要发的字段；只放真改了的格子，空补丁由调用方拦下、根本不发请求。 */
export interface IssueUpdateFields {
  repo?: string
  title?: string
  body?: string
  state?: string
  labels?: string
  assignee?: string
  parent_id?: number
  milestone?: number
}

/** 改票。 */
export function requestIssueUpdate(
  opCtx: GiteeCtx,
  refId: string,
  key: string,
  fields: IssueUpdateFields,
  timeoutMs: number,
): Promise<GiteeRunResult> {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) body[k] = v
  return clientOf(opCtx).api(ownerIssuePath(refId, key), { method: 'PATCH', body }, { timeout: timeoutMs })
}

/** 列全部标签：Gitee 这个端点没有分页参数，一次读完。 */
export function requestLabelList(opCtx: GiteeCtx, refId: string, timeoutMs: number): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(labelsPath(refId), {}, { timeout: timeoutMs })
}

/** 新建标签（颜色不带井号）。 */
export function requestLabelCreate(
  opCtx: GiteeCtx,
  refId: string,
  name: string,
  color: string,
  timeoutMs: number,
): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(labelsPath(refId), { method: 'POST', body: { name, color } }, { timeout: timeoutMs })
}

/** 改标签：给名字就是改名，给颜色就是改色，两个一起给就是都改。 */
export function requestLabelUpdate(
  opCtx: GiteeCtx,
  refId: string,
  originalName: string,
  fields: { new_name?: string; color?: string },
  timeoutMs: number,
): Promise<GiteeRunResult> {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') body[k] = v
  return clientOf(opCtx).api(labelPath(refId, originalName), { method: 'PATCH', body }, { timeout: timeoutMs })
}

/** 读里程碑（第一批只在 update 里按名字查 id 用）。 */
export function requestMilestones(opCtx: GiteeCtx, refId: string, query: string, timeoutMs: number): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(milestonesPath(refId, query), {}, { timeout: timeoutMs })
}

/** 当前登录人。 */
export function requestCurrentUser(opCtx: GiteeCtx, timeoutMs: number): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(currentUserPath(), {}, { timeout: timeoutMs })
}

/** 仓库定义（含 permission）。 */
export function requestRepo(opCtx: GiteeCtx, refId: string, timeoutMs: number): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(repoPath(refId), {}, { timeout: timeoutMs })
}

/** 协作者列表；权限问不出来时的第二证据源。 */
export function requestCollaborators(opCtx: GiteeCtx, refId: string, timeoutMs: number): Promise<GiteeRunResult> {
  return clientOf(opCtx).api(repoPath(refId) + '/collaborators', {}, { timeout: timeoutMs })
}

/** 建远端仓库（个人命名空间）。 */
export function requestRepoCreate(opCtx: GiteeCtx, fields: Record<string, unknown>, timeoutMs: number): Promise<GiteeRunResult> {
  const body: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') body[k] = v
  return clientOf(opCtx).api(userReposPath(), { method: 'POST', body }, { timeout: timeoutMs })
}

export default {
  requestIssueList,
  requestIssueGet,
  requestCommentList,
  requestCommentCreate,
  requestIssueCreate,
  requestIssueUpdate,
  requestLabelList,
  requestLabelCreate,
  requestLabelUpdate,
  requestMilestones,
  requestCurrentUser,
  requestRepo,
  requestCollaborators,
  requestRepoCreate,
}