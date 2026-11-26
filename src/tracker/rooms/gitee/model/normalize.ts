/**
 * src/tracker/rooms/gitee/model/normalize.ts —— 把 Gitee 的票与标签形状折成契约实体
 *
 * Gitee 的票有几个和别的房不一样的地方，全部在这里一次处理完，别处不再猜字段：
 *   · 状态是四态 open/progressing/closed/rejected；契约只有两态，四态里前两个算 open、
 *     后两个算 closed，而原值不能丢——它进 reason，读回的人还能看到是「已完成」还是「已拒绝」；
 *   · 票号是字符串（形如 I8A2BC），就放在 number 字段里，绝不能当数字用；
 *   · 认领人是单值 assignee，不是数组；这里统一折成只有一项的数组；
 *   · 没有 closed_at 字段，所以 closedAt 只能给 null，不拿 updated_at 冒充；
 *   · 没有拉取请求混在票列表里的问题（Gitee 的 issues 端点只回票），所以不设 isPullRequest。
 *
 * 父票有两个来源，优先级固定：远端结构字段（parentKey 或 parent_url 尾段）有值就以它为准；
 * 结构字段没有时，才从正文开头那行 `上级地图：#票号` 解析回来（Gitee 的 parent_id 会被静默忽略，
 * 写侧因此把关系同时写进正文，见 model/parent-line.ts）。结构字段为什么只认非纯数字尾段：Gitee 只给
 * 父票的数字 id，而所有接口路径都要字符串票号，没有 id→票号的查询端点；与其编一个数字当 parentKey，
 * 不如给 null 并让上层写一行退化日志。
 *
 * 来源随票一起交给上层（parentSource）：调用方要能说清「这条父子是远端结构给的，还是正文兜底来的」，
 * 否则写后读回只能证明 parentKey 有值，分不出远端到底认没认 parent_id。
 */
import type { Comment, Issue, Label, Milestone } from '../../../contract/entities.js'
import type { Actor, IssueType, State } from '../../../contract/identity.js'
import { ISSUE_TYPE, STATE } from '../../../contract/vocabulary.js'
import { markerKindInHeader } from '../../../../shared/issue-file/src/marker.js'
import { parentKeyFromBody } from './parent-line.js'
import { normalizeColor } from '../../../../shared/label-color/src/colors.js'
import { isMapLabel, toCanonical } from '../support/label-alias.js'

/** 回包是不是一个键值袋。 */
export function asBag(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** 颜色统一成不带井号的六位小写十六进制；给不出就空串（契约里空串表示「没有颜色」）。 */
function colorOf(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) return ''
  const normalized = normalizeColor(v)
  return normalized === null ? '' : normalized
}

function normalizeLabel(raw: unknown): Label | null {
  const bag = asBag(raw)
  // Gitee 上的真实标签名是 wayfinder-map，契约与 deck 用 wayfinder:map；读回来先统一成 canonical 名，
  // 这样类型推断、列表筛选、面板展示都只需要认识一套名字。
  const name = toCanonical(str(bag['name']).trim())
  if (!name) return null
  const label: Label = { name, color: colorOf(bag['color']) }
  const description = str(bag['description']).trim()
  if (description) label.description = description
  return label
}

function normalizeLabels(raw: unknown): Label[] {
  const list = Array.isArray(raw) ? raw : asBag(raw)['labels']
  if (!Array.isArray(list)) return []
  const out: Label[] = []
  for (const item of list) {
    const label = normalizeLabel(item)
    if (label) out.push(label)
  }
  return out
}

/** 票号字段：number 是 Gitee 的字符串标识（I8A2BC），实在没有才退回数字 id。 */
function deriveKey(bag: Record<string, unknown>): string {
  for (const field of ['number', 'key', 'id']) {
    const value = bag[field]
    if (typeof value === 'string' && value.trim()) return value.trim()
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  }
  return '0'
}

function bodyOf(bag: Record<string, unknown>): string {
  const body = bag['body']
  if (typeof body === 'string') return body
  const description = bag['description']
  return typeof description === 'string' ? description : ''
}

/** 类型推断：正文里的规格标记优先，其次地图标签，其余都算普通票。 */
function deriveType(bag: Record<string, unknown>, body: string, labels: Label[]): IssueType {
  if (markerKindInHeader(body) === 'spec') return ISSUE_TYPE.SPEC
  if (labels.some((l) => isMapLabel(l.name))) return ISSUE_TYPE.MAP
  if (bag['isMap'] === true || bag['type'] === 'map') return ISSUE_TYPE.MAP
  return ISSUE_TYPE.ISSUE
}

/** 四态归一：open/progressing 算开，closed/rejected 算关；认不出的一律算开（不丢票）。 */
function deriveState(bag: Record<string, unknown>): State {
  const raw = str(bag['state']).trim().toLowerCase()
  if (raw === 'closed' || raw === 'rejected' || raw === 'close') return STATE.CLOSED
  return STATE.OPEN
}

function normalizeMilestone(raw: unknown): Milestone | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bag = asBag(raw)
  const name = str(bag['title']).trim() || str(bag['name']).trim()
  if (!name) return null
  const milestone: Milestone = { name }
  const description = str(bag['description']).trim()
  if (description) milestone.description = description
  const state = str(bag['state']).trim().toLowerCase()
  if (state) milestone.state = state === 'closed' || state === 'close' ? STATE.CLOSED : STATE.OPEN
  const due = str(bag['due_on']) || str(bag['due_date']) || str(bag['dueOn'])
  if (due) milestone.dueOn = due
  return milestone
}

function normalizeActor(raw: unknown): Actor | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bag = asBag(raw)
  const login = str(bag['login']).trim() || str(bag['username']).trim()
  if (!login) return null
  const actor: Actor = { login }
  const name = str(bag['name']).trim()
  if (name) actor.name = name
  const avatarUrl = str(bag['avatar_url']).trim()
  if (avatarUrl) actor.avatarUrl = avatarUrl
  return actor
}

/** 认领人只有一个位置（assignee），折成一项数组；没有就是空数组。 */
function normalizeAssignees(bag: Record<string, unknown>): Actor[] {
  const single = normalizeActor(bag['assignee'])
  if (single) return [single]
  const list = bag['assignees']
  if (!Array.isArray(list)) return []
  const out: Actor[] = []
  for (const item of list) {
    const actor = normalizeActor(item)
    if (actor) out.push(actor)
  }
  return out
}

function normalizeComments(raw: unknown): Comment[] {
  if (!Array.isArray(raw)) return []
  const out: Comment[] = []
  for (const item of raw) {
    const bag = asBag(item)
    const body = str(bag['body'])
    const author = normalizeActor(bag['user']) || { login: '' }
    const createdAt = str(bag['created_at']) || str(bag['createdAt'])
    const updatedAt = str(bag['updated_at']) || str(bag['updatedAt']) || createdAt
    const comment: Comment = { author, authorAssociation: '', body, createdAt, updatedAt }
    const id = bag['id']
    if (typeof id === 'number' || typeof id === 'string') comment.id = String(id)
    out.push(comment)
  }
  return out
}

/** parent_url 尾段是不是一个能用的票号：非空、不是纯数字（纯数字是远端内部 id，不能当票号）。 */
function keyFromParentUrl(raw: unknown): string | null {
  const url = str(raw).trim()
  if (!url) return null
  const match = /\/issues\/([^\/?#]+)\/?$/.exec(url)
  if (!match) return null
  const tail = decodeURIComponent(match[1]).trim()
  if (!tail || /^[0-9]+$/.test(tail)) return null
  return tail
}

/** 父票的来源：远端结构字段，或者票正文里那行兜底文字。 */
export type ParentSource = 'structure' | 'body'

/** 归一后的票多挂一格来源。契约的 Issue 没有这一列，写法照 GitHub 房挂 parentError 的先例。 */
export type GiteeIssue = Issue & { parentSource?: ParentSource }

/**
 * 推出父票票号与它的来源。结构字段优先；结构字段没有值时才读正文，两边都没有就给 null。
 *
 * 为什么不让正文盖过结构字段：结构字段是远端的真账，正文可能是人手写的旧行；
 * 结构字段有值时以它为准，正文只在结构字段读不出来时兜底。
 */
function deriveParent(bag: Record<string, unknown>, body: string): { key: string | null; source: ParentSource | null } {
  const direct = bag['parentKey']
  const structural = (typeof direct === 'string' && direct.trim()) ? direct.trim() : keyFromParentUrl(bag['parent_url'])
  if (structural) return { key: structural, source: 'structure' }
  const fromBody = parentKeyFromBody(body)
  if (fromBody) return { key: fromBody, source: 'body' }
  return { key: null, source: null }
}

/**
 * 归一一张票。
 *
 * 除核心字段外，只挂远端真的给了的东西：labels/assignees/comments 恒为数组（契约要求恒有这一格），
 * milestone/author 只在回包里有对象时才挂，commentCount 只在回包给了非负整数时才挂。
 */
export function normalizeIssue(raw: unknown): Issue {
  const bag = asBag(raw)
  const labels = normalizeLabels(bag['labels'])
  const body = bodyOf(bag)
  const state = deriveState(bag)
  const key = deriveKey(bag)
  const parent = deriveParent(bag, body)
  const issue: GiteeIssue = {
    key,
    effortId: '',
    type: deriveType(bag, body, labels),
    title: str(bag['title']).trim(),
    state,
    body,
    url: str(bag['html_url']) || str(bag['url']),
    createdAt: str(bag['created_at']) || str(bag['createdAt']),
    updatedAt: str(bag['updated_at']) || str(bag['updatedAt']) || str(bag['created_at']) || str(bag['createdAt']),
    closedAt: null,
    parentKey: parent.key,
    labels,
    assignees: normalizeAssignees(bag),
    comments: normalizeComments(bag['comments']),
    blockedBy: [],
    reason: state === STATE.CLOSED ? (str(bag['state']).trim().toLowerCase() || 'closed') : '',
  }
  // 只有真读出父票时才写来源：父票为 null 时写一个来源，会让上层以为「有父票但读不出来」。
  if (parent.source) issue.parentSource = parent.source
  const author = normalizeActor(bag['user'])
  if (author) issue.author = author
  const milestone = normalizeMilestone(bag['milestone'])
  if (milestone) issue.milestone = milestone
  const commentCount = num(bag['comments'])
  if (commentCount !== null && commentCount >= 0) issue.commentCount = Math.floor(commentCount)
  return issue
}

/** 只归一一个标签（改标签颜色、列标签用）。 */
export function normalizeLabelEntry(raw: unknown): Label | null {
  return normalizeLabel(raw)
}

export default normalizeIssue
