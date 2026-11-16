/**
 * src/tracker/rooms/gitee/issues/write.ts —— 建票、关票、重开、改票与三类字段写入
 *
 * 这一层只做三件事：把契约输入翻成 Gitee 的正文、发出去、把回包折回契约实体。
 * 判档一律交给 errors.ts（分类失败也走 fail(...)，不抛异常）。
 *
 * 几个必须记住的 Gitee 事实（照 swagger，不照记忆）：
 *   · 建票与改票都是 owner 级路径，仓库名要放在正文的 repo 字段里；
 *   · 认领人只有一个位置 assignee，不是数组——多个人时如实回 unsupported，不丢人、不覆盖；
 *   · parent_id 收的是数字，票号是字符串，所以挂父票前必须先用父票号把父票读回来拿数字 id；
 *   · 没有任何「移到根」的写法（swagger 全表查不到 0 或空串的含义），传 null 只能如实说做不到。
 */
import type { BackendContext, OpContext } from '../../../contract/contexts.js'
import type { Issue, RepositoryRef } from '../../../contract/entities.js'
import type { AssigneeInput, CloseOpts, CreateInput, LabelInput, SetOpts, UpdatePatch } from '../../../contract/inputs.js'
import type { IssueDetailResult, OpResult } from '../../../contract/results.js'
import { TRACKER_ERROR_STAGE } from '../../../contract/results.js'
import { ERROR_KIND } from '../../../contract/vocabulary.js'
import { fail } from '../../../kernel/preflight.js'
import { GITEE_READ_TIMEOUT_MS, GITEE_SLOW_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { failGitee } from '../errors.js'
import { requestIssueCreate, requestIssueUpdate, requestMilestones } from '../requests.js'
import { normalizeIssue } from '../model/normalize.js'
import { parseJsonSafe } from '../support/json.js'
import { repoNameOf, repoRefId } from '../support/repo-ref.js'
import { LIST_MAX_PAGES, PAGE_SIZE, asRows, isBag } from './shared.js'
import { fetchIssueRaw, getIssue } from './read.js'

type GiteeCtx = Partial<OpContext> & Partial<BackendContext>
export type Repo = Partial<RepositoryRef> | null | undefined

function textOf(res: { stdout?: string; stderr?: string }): string {
  return String(res.stderr || '') || String(res.stdout || '')
}

function namesOf(labels: unknown): string[] {
  if (!Array.isArray(labels)) return []
  const out: string[] = []
  for (const item of labels) {
    const name = typeof item === 'string' ? item : item && typeof item === 'object' ? String((item as { name?: unknown }).name || '') : ''
    const trimmed = name.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

function loginsOf(assignees: unknown): string[] {
  if (!Array.isArray(assignees)) return []
  const out: string[] = []
  for (const item of assignees) {
    const login = typeof item === 'string' ? item : item && typeof item === 'object' ? String((item as { login?: unknown }).login || '') : ''
    const trimmed = login.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }
  return out
}

/** 把父票号翻成 parent_id 要的数字 id；父票读不到就回 null（调用方决定怎么报）。 */
async function resolveParentId(opCtx: GiteeCtx, refId: string, parentKey: string): Promise<number | null> {
  const fetched = await fetchIssueRaw(opCtx, refId, parentKey)
  if (!fetched.ok) return null
  const id = fetched.bag['id']
  return typeof id === 'number' && Number.isFinite(id) ? id : null
}

function normalizePatchReply(
  res: { stdout?: string; stderr?: string; code?: number },
  fallback: string,
): { ok: true; issue: Issue } | { ok: false; result: OpResult<Issue> } {
  if (res.code !== 0) {
    return { ok: false, result: failGitee(res, textOf(res) || fallback, res) }
  }
  const parsed = parseJsonSafe(res.stdout)
  if (!isBag(parsed)) {
    return { ok: false, result: failGitee(res, 'write: 回包不是一个 JSON 对象', res) }
  }
  return { ok: true, issue: normalizeIssue(parsed) }
}

/**
 * 建票。
 *
 * idempotencyKey 照发但不产生去重效果：Gitee 没有幂等锚这回事，远端不会因为同一个键
 * 把第二次请求当成重放。这里不谎称「已去重」，也不拒收——调用方传了它，说明调用方
 * 做好了「失败后重试可能多一张票」的心理准备。
 */
export async function createIssue(
  ctx: GiteeCtx,
  repo: Repo,
  input: CreateInput,
  opCtx?: GiteeCtx,
): Promise<OpResult<Issue>> {
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'create: repo.refId missing', '')
  const title = String(input && input.title != null ? input.title : '').trim()
  if (!title) return fail(ERROR_KIND.PARSE, 'create: title required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)

  try {
    const labels = namesOf(input.labels)
    // 地图票在 Gitee 上靠标签认，正文标记由调用方写；这里只补那一枚地图标签。
    if (input.type === 'map' && !labels.includes('wayfinder:map')) labels.push('wayfinder:map')
    const logins = loginsOf(input.assignees)
    const fields: Parameters<typeof requestIssueCreate>[2] = {
      repo: repoNameOf(refId),
      title,
      body: typeof input.body === 'string' && input.body ? input.body : undefined,
      labels: labels.length ? labels.join(',') : undefined,
      assignee: logins.length ? logins[0] : undefined,
    }
    if (input.parentKey) {
      const parentId = await resolveParentId(effective, refId, String(input.parentKey))
      if (parentId === null) {
        return failGitee('create: 父票没找到', 'create: 父票 ' + String(input.parentKey) + ' 没找到（或没有权限看它），票没有建', String(input.parentKey), effective)
      }
      fields.parent_id = parentId
    }
    const res = await requestIssueCreate(effective, refId, fields, GITEE_SLOW_READ_TIMEOUT_MS)
    const reply = normalizePatchReply(res, 'create: gitee api 建票失败')
    if (!reply.ok) return reply.result
    if (!reply.issue.key || reply.issue.key === '0') {
      return failGitee(res, 'create: 回包里没有票号', res)
    }
    return { ok: true, data: reply.issue }
  } catch (err) {
    return failGitee(err, 'create: gitee api 建票调用失败', err, effective)
  }
}

/** 关票：写 state=closed。Gitee 没有独立的关闭原因字段，opts.reason 原样记在返回实体上。 */
export async function closeIssue(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  opts: CloseOpts | undefined,
  opCtx?: GiteeCtx,
): Promise<OpResult<Issue>> {
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'close: repo.refId missing', '')
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) return fail(ERROR_KIND.PARSE, 'close: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  try {
    const res = await requestIssueUpdate(effective, refId, wantedKey, { repo: repoNameOf(refId), state: 'closed' }, GITEE_READ_TIMEOUT_MS)
    const reply = normalizePatchReply(res, 'close: gitee api 关票失败')
    if (!reply.ok) return reply.result
    const reason = opts && typeof opts.reason === 'string' ? opts.reason.trim() : ''
    if (reason) reply.issue.reason = reason
    return { ok: true, data: reply.issue }
  } catch (err) {
    return failGitee(err, 'close: gitee api 关票调用失败', err, effective)
  }
}

/** 重开：同一端点写 state=open；progressing 读回算开，所以一律重开成 open。 */
export async function reopenIssue(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  opCtx?: GiteeCtx,
): Promise<OpResult<Issue>> {
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'reopen: repo.refId missing', '')
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) return fail(ERROR_KIND.PARSE, 'reopen: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  try {
    const res = await requestIssueUpdate(effective, refId, wantedKey, { repo: repoNameOf(refId), state: 'open' }, GITEE_READ_TIMEOUT_MS)
    const reply = normalizePatchReply(res, 'reopen: gitee api 重开失败')
    if (!reply.ok) return reply.result
    return { ok: true, data: reply.issue }
  } catch (err) {
    return failGitee(err, 'reopen: gitee api 重开调用失败', err, effective)
  }
}

/** 按名字在远端找里程碑的数字 id；找不到回 null。 */
async function resolveMilestoneId(opCtx: GiteeCtx, refId: string, name: string): Promise<number | null> {
  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const query = 'per_page=' + PAGE_SIZE + '&page=' + page
    const res = await requestMilestones(opCtx, refId, query, GITEE_READ_TIMEOUT_MS)
    if (res.code !== 0) return null
    const rows = asRows(parseJsonSafe(res.stdout))
    if (!rows) return null
    for (const row of rows) {
      const bag = isBag(row) ? row : {}
      const title = String(bag['title'] || bag['name'] || '').trim()
      const id = bag['number'] !== undefined ? bag['number'] : bag['id']
      if (title === name && typeof id === 'number' && Number.isFinite(id)) return id
    }
    if (rows.length < PAGE_SIZE) return null
  }
  return null
}

/**
 * 改票。
 *
 * 「只发真改了的字段」是硬要求：把没改的字段一起发出去，会用一个可能已经过期的读回值
 * 覆盖别人刚做的修改。所以先按 patch 里出现过哪些键组正文，正文为空就根本不发请求。
 *
 * 里程碑清空（patch.milestone === null）在 Gitee 上没有写法：正文里的 milestone 只收数字，
 * 没有 0 或空串的约定，所以如实回 unsupported，而不是发一个含义不明的 0。
 */
export async function updateIssue(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  patch: UpdatePatch,
  opCtx?: GiteeCtx,
): Promise<OpResult<Issue>> {
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'update: repo.refId missing', '')
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) return fail(ERROR_KIND.PARSE, 'update: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  const p: UpdatePatch = patch || {}

  if (p.customFields && Object.keys(p.customFields).length) {
    return failGitee('customFields not supported', 'update: Gitee 的票没有自定义字段这一层，改不了', JSON.stringify(p.customFields))
  }
  if (p.milestone === null) {
    return failGitee('milestone clear unsupported', 'update: Gitee 的改票正文没有清空里程碑的写法（milestone 只收数字 id），这一次没有改名目', '')
  }

  const fields: Parameters<typeof requestIssueUpdate>[3] = { repo: repoNameOf(refId) }
  let changed = false
  if (p.title !== undefined) {
    const title = String(p.title).trim()
    if (!title) return fail(ERROR_KIND.PARSE, 'update: 标题不能改成空串', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
    fields.title = title
    changed = true
  }
  if (p.body !== undefined) {
    fields.body = String(p.body)
    changed = true
  }
  try {
    if (p.milestone !== undefined && p.milestone !== null) {
      const name = String(p.milestone.name || '').trim()
      const milestoneId = name ? await resolveMilestoneId(effective, refId, name) : null
      if (milestoneId === null) {
        return failGitee('milestone not found', 'update: 里程碑 ' + name + ' 在远端没找到', name)
      }
      fields.milestone = milestoneId
      changed = true
    }
    if (!changed) return getIssue(effective, repo, wantedKey, {}, effective)
    const res = await requestIssueUpdate(effective, refId, wantedKey, fields, GITEE_READ_TIMEOUT_MS)
    const reply = normalizePatchReply(res, 'update: gitee api 改票失败')
    if (!reply.ok) return reply.result
    return { ok: true, data: reply.issue }
  } catch (err) {
    return failGitee(err, 'update: gitee api 改票调用失败', err, effective)
  }
}

/** 覆盖式写标签；传空数组就是清空（正文里发 labels=''，远端据此摘掉全部标签）。 */
export async function setLabels(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  labels: LabelInput[],
  opts: SetOpts | undefined,
  opCtx?: GiteeCtx,
): Promise<OpResult<Issue>> {
  void opts
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'setLabels: repo.refId missing', '')
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) return fail(ERROR_KIND.PARSE, 'setLabels: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  try {
    const res = await requestIssueUpdate(
      effective,
      refId,
      wantedKey,
      { repo: repoNameOf(refId), labels: namesOf(labels).join(',') },
      GITEE_READ_TIMEOUT_MS,
    )
    const reply = normalizePatchReply(res, 'setLabels: gitee api 改标签失败')
    if (!reply.ok) return reply.result
    return { ok: true, data: reply.issue }
  } catch (err) {
    return failGitee(err, 'setLabels: gitee api 改标签调用失败', err, effective)
  }
}

/**
 * 写认领人。
 *
 * Gitee 的认领人只有一个位置（assignee，字符串），所以：0 个 = 清空、1 个 = 直接写、
 * 2 个以上 = 如实回 unsupported。第三种不许挑一个写进去——那等于替用户悄悄丢了其余的人。
 */
export async function setAssignees(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  assignees: AssigneeInput[],
  opts: SetOpts | undefined,
  opCtx?: GiteeCtx,
): Promise<OpResult<Issue>> {
  void opts
  const effective = opCtx || ctx
  const refId = repoRefId(repo)
  if (!refId) return failGitee('repo.refId missing', 'setAssignees: repo.refId missing', '')
  const wantedKey = String(key == null ? '' : key).trim()
  if (!wantedKey) return fail(ERROR_KIND.PARSE, 'setAssignees: key required', '', TRACKER_ERROR_STAGE.INPUT_REFUSED)
  const logins = loginsOf(assignees)
  if (logins.length > 1) {
    return failGitee(
      'assignee single-valued',
      'setAssignees: Gitee 的一张票只有一个认领人位置，给 ' + String(logins.length) + ' 个人没法如实写进去（没有偷偷只写第一个）',
      JSON.stringify(logins),
    )
  }
  try {
    const res = await requestIssueUpdate(
      effective,
      refId,
      wantedKey,
      { repo: repoNameOf(refId), assignee: logins.length ? logins[0] : '' },
      GITEE_READ_TIMEOUT_MS,
    )
    const reply = normalizePatchReply(res, 'setAssignees: gitee api 改认领失败')
    if (!reply.ok) return reply.result
    return { ok: true, data: reply.issue }
  } catch (err) {
    return failGitee(err, 'setAssignees: gitee api 改认领调用失败', err, effective)
  }
}

/**
 * 挂父票 / 拆父票。
 *
 * 挂：先把父票号读回来拿数字 id，再 PATCH parent_id。
 * 拆（parentKey === null）：Gitee 没有「移到根」的写法，如实回 unsupported。
 * 这一条是「形态不合」，不是「没做」：发一个含义不明的 0 有可能把票挂到不存在的父票上。
 */
export async function setParent(
  ctx: GiteeCtx,
  repo: Repo,
  key: string,
  parentKey: string | null,
  opts: SetOpts | undefined,
  opCtx?: GiteeCtx,
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
    if (!reply.ok) return reply.result
    // 回包里的 parent_url 才是远端的真相；parent_id 只是数字，不能当 parentKey 用。
    if (!reply.issue.parentKey) reply.issue.parentKey = parent
    return { ok: true, data: reply.issue }
  } catch (err) {
    return failGitee(err, 'setParent: gitee api 挂父票调用失败', err, effective)
  }
}

export default {
  createIssue,
  closeIssue,
  reopenIssue,
  updateIssue,
  setLabels,
  setAssignees,
  setParent,
}
