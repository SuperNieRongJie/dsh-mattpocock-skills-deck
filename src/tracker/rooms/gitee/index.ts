/**
 * src/tracker/rooms/gitee/index.ts —— Gitee 房的入口：模块对象、工厂、识别
 *
 * 与其它三房一样，这个文件只做三件事：声明「这间房长什么样」（模块对象）、
 * 按上下文造出一张操作表（工厂）、判断某个工作区是不是 Gitee（matches 四层）。
 * 链接、提示词、修复动作放在 room/ 下，这里原样再导出，别的模块从入口就能拿到。
 *
 * 四层识别从便宜到贵：先看调用方给的 refId，再看 .git/config 的 remote，
 * 再看仓库里那份 issue-tracker.md 的显式声明，最后才起一次 git 问 origin。
 * 每一层读不到都记一行 read.degraded，写明卡在哪一层——只回 false 的话，
 * 用户看到的是「没认出 Gitee」，却不知道是没文件、没权限、还是文件里写的是别的后端。
 *
 * 登记为「明确不支持」的两条（ensureLabelColorsFile / readBudget）故意不在工厂里造桩：
 * 注册表会替缺失的操作补桩，房间再造一个就成了两处说法、迟早不一致。
 * 阻塞关系（getDependencies / setBlockedBy）与父票一样登记成「做了但没做到位」：Gitee 没有
 * 阻塞边的结构字段，只能把关系写进票正文末尾的 `## Blocked by` 小节再读回来，所以工厂里真的有这两条。
 */
import type { BackendContext, OpContext, RepoHandle } from '../../contract/contexts.js'
import type { RepositoryRef } from '../../contract/entities.js'
import type { BackendId } from '../../contract/identity.js'
import type { Tracker } from '../../contract/operations.js'
import type { BackendModule } from '../../contract/backend-module.js'
import type { PartiallyProvidedCapability, ProvidedCapability } from '../../contract/capability-answer.js'
import { remoteUrlsOfGitConfig } from '../../kernel/git-remote.js'
import { normalizeTrackerText, parseIssueTracker } from '../../kernel/issue-tracker-declaration.js'
import { GITEE_FALLBACK_TIMEOUT_MS } from '../../../shared/time-config/src/values.js'
import { giteePreflight } from './preflight.js'
import { attachGiteeOpUsage } from './client.js'
import { emitReadDegraded } from './support/read-log.js'
import { getRepoKey, giteeOriginOf, learnGiteeOrigin } from './model/repo-identity.js'
import { listIssues, getIssue } from './issues/read.js'
import { createIssue, closeIssue, reopenIssue, updateIssue, setLabels, setAssignees, setParent } from './issues/write.js'
import { getDependencies } from './issues/dependencies.js'
import { setBlockedBy } from './issues/blocked-by.js'
import { addComment } from './comments/write.js'
import { counts } from './issues/counts.js'
import { listPage } from './issues/pages.js'
import { listSubIssues } from './issues/sub-issues.js'
import { listMaps } from './issues/maps.js'
import { listLabels } from './labels/list.js'
import { setLabelColors } from './labels/colors.js'
import { getCurrentUser } from './repo/current-user.js'
import { getRepoPermissions } from './repo/permissions.js'
import { initProject } from './project/init-project.js'
import type { GITEE_CAPABILITY_REGISTER } from './support/capability-register.js'
import { DEFAULT_GITEE_WEB_ORIGIN, issueAddress, issueRefPattern, links, repoSearchAddress } from './room/links.js'
import { prompts } from './room/prompts.js'
import { fixes } from './room/fixes.js'

export { issueAddress, repoSearchAddress, issueRefPattern, links }
export { prompts }
export { fixes }

export type GiteeBackendMembers =
  | 'id'
  | (ProvidedCapability<typeof GITEE_CAPABILITY_REGISTER> | PartiallyProvidedCapability<typeof GITEE_CAPABILITY_REGISTER>)

export type GiteeBackendShape = { [K in GiteeBackendMembers]: Tracker[K] }

type MarkerFs = OpContext['fs']

/** 读一个工作区内的文件；读不到（不存在、没权限、形状不对）一律回 null，由调用方记退化行。 */
async function readWorkspaceFile(fs: MarkerFs, cwd: string, rel: string): Promise<string | null> {
  try {
    const target = await fs.resolve(rel, { cwd })
    const text = await fs.readText(target)
    return typeof text === 'string' ? text : null
  } catch {
    return null
  }
}

/** 从 .git/config 里认出 Gitee 源并记下来，供同步的 describe 使用。 */
function learnOriginFromConfig(cwd: string, config: string): boolean {
  const urls = remoteUrlsOfGitConfig(config)
  let hit = false
  for (const url of urls) {
    if (/gitee/i.test(url)) {
      learnGiteeOrigin(cwd, url)
      hit = true
    }
  }
  return hit
}

/**
 * 四层识别。
 *
 * ②③ 两层都要求先拿到 fs 能力；拿不到时记一行 matches:fs-unavailable 直接回 false，
 * 因为后面两层本来也读不到文件，继续试只会多两行相同的退化记录。
 */
export async function matches(handle: RepoHandle, ctx: OpContext): Promise<boolean> {
  const startedAt = Date.now()
  try {
    if (!handle || typeof handle !== 'object') return false
    if (typeof handle.refId === 'string' && /gitee/i.test(handle.refId)) return true
    const cwd = typeof handle.cwd === 'string' ? handle.cwd : ''
    if (!cwd) return false

    const platform = ctx && ctx.platform
    const fs = (ctx && ctx.fs) || (platform && platform.fs)
    const canRead = fs && typeof fs.resolve === 'function' && typeof fs.readText === 'function'
    if (!canRead) {
      emitReadDegraded(ctx, 'matches', 'matches:fs-unavailable', Date.now() - startedAt)
      return false
    }

    const cfg = await readWorkspaceFile(fs, cwd, '.git/config')
    if (cfg === null) {
      emitReadDegraded(ctx, 'matches', 'matches:git-config', Date.now() - startedAt)
    } else if (learnOriginFromConfig(cwd, cfg)) {
      return true
    }

    const doc = await readWorkspaceFile(fs, cwd, 'docs/agents/issue-tracker.md')
    if (doc === null) {
      emitReadDegraded(ctx, 'matches', 'matches:tracker-doc', Date.now() - startedAt)
    } else {
      const parsed = parseIssueTracker(normalizeTrackerText(doc))
      if (parsed && parsed.confidence === 'high' && parsed.explicitBackendId === 'gitee') return true
    }

    const exec = ctx && ctx.exec
    if (typeof exec === 'function') {
      const res = await exec('git', ['remote', 'get-url', 'origin'], { cwd, timeout: GITEE_FALLBACK_TIMEOUT_MS })
      const out = String((res && res.stdout) || '') + String((res && res.stderr) || '')
      if (/gitee/i.test(out)) {
        learnGiteeOrigin(cwd, out.trim())
        return true
      }
    }
    return false
  } catch {
    emitReadDegraded(ctx, 'matches', 'matches:unknown', Date.now() - startedAt)
    return false
  }
}

/**
 * 给一个仓库引用起个像样的描述。
 *
 * refId 是第一优先；没有 refId 时用目录名当 name（用户看得出这是哪个工作区），
 * url 只在 refId 是 owner/repo 两段时才拼——一段的标识拼不出网页地址，硬拼会给出一个打不开的链接。
 * host 与默认域名相同时不写，避免所有 Gitee 仓库都顶着一条冗余字段。
 */
export function describe(
  handle: Partial<RepoHandle> & { host?: string },
  backendId: BackendId = 'gitee',
): RepositoryRef {
  const refId = typeof handle.refId === 'string' ? handle.refId.trim() : ''
  const cwd = typeof handle.cwd === 'string' ? handle.cwd.trim() : ''
  const declaredHost = typeof handle.host === 'string' ? handle.host.trim().replace(/\/+$/, '') : ''
  const learnedHost = !declaredHost && cwd ? giteeOriginOf(cwd) : ''
  const host = declaredHost || learnedHost
  const name = refId || (cwd ? cwd.split(/[\\/]/).pop() || cwd : backendId) || backendId
  const url = refId && refId.includes('/') ? (host || DEFAULT_GITEE_WEB_ORIGIN) + '/' + refId : ''
  const ref: RepositoryRef = { backend: backendId, refId: refId || '', name, url }
  if (host && host !== DEFAULT_GITEE_WEB_ORIGIN) ref.host = host
  return ref
}

const openRepository = 'url'

/**
 * 工厂：把共享内核注入的上下文与各操作的具体实现接起来。
 *
 * 调用约定与 GitLab 房逐字一致：前一组操作的上下文在第一个参数，后一组
 * （counts/listPage/listLabels/setLabelColors/getCurrentUser/getRepoPermissions/listSubIssues/initProject/listMaps）
 * 在最后一个参数。这个差异来自契约签名本身，不要顺手统一。
 */
export function createGiteeBackend(ctx: BackendContext) {
  const backend = {
    id: 'gitee',
    describe: (handle) => describe(handle, 'gitee'),
    issueAddress: (ref, key) => issueAddress(ref, key),
    getRepoKey: (cwd, opCtx) => getRepoKey(cwd, opCtx || ctx),
    preflight: (handle, opCtx) => giteePreflight(handle, opCtx || ctx),
    list: (repo, filter, opCtx) => listIssues(ctx, repo, filter, opCtx || ctx),
    get: (repo, key, opts, opCtx) => getIssue(ctx, repo, key, opts, opCtx || ctx),
    create: (repo, input, opCtx) => createIssue(ctx, repo, input, opCtx || ctx),
    close: (repo, key, opts, opCtx) => closeIssue(ctx, repo, key, opts, opCtx || ctx),
    reopen: (repo, key, opCtx) => reopenIssue(ctx, repo, key, opCtx || ctx),
    comment: (repo, key, body, opCtx) => addComment(ctx, repo, key, body, opCtx || ctx),
    update: (repo, key, patch, opCtx) => updateIssue(ctx, repo, key, patch, opCtx || ctx),
    setLabels: (repo, key, labels, opts, opCtx) => setLabels(ctx, repo, key, labels, opts, opCtx || ctx),
    setAssignees: (repo, key, assignees, opts, opCtx) => setAssignees(ctx, repo, key, assignees, opts, opCtx || ctx),
    setParent: (repo, key, parentKey, opts, opCtx) => setParent(ctx, repo, key, parentKey, opts, opCtx || ctx),
    getDependencies: (repo, key, opts, opCtx) => getDependencies(ctx, repo, key, opts, opCtx || ctx),
    setBlockedBy: (repo, key, blockers, opts, opCtx) => setBlockedBy(ctx, repo, key, blockers, opts, opCtx || ctx),
    counts: (repo, filter, opCtx) => counts(opCtx || ctx, repo, filter, opCtx || ctx),
    listPage: (repo, filter, opts, opCtx) => listPage(opCtx || ctx, repo, filter, opts, opCtx || ctx),
    listLabels: (repo, opCtx) => listLabels(opCtx || ctx, repo),
    setLabelColors: (repo, changes, opCtx) => setLabelColors(opCtx || ctx, repo, changes),
    getCurrentUser: (repo, opCtx) => getCurrentUser(opCtx || ctx, repo),
    getRepoPermissions: (repo, opCtx) => getRepoPermissions(opCtx || ctx, repo),
    listSubIssues: (repo, mapKey, opts, opCtx) => listSubIssues(opCtx || ctx, repo, mapKey, opts, opCtx || ctx),
    initProject: (handle, input, opCtx) => initProject(handle, input, opCtx || ctx),
    listMaps: (repo, opCtx) => listMaps(opCtx || ctx, repo),
  } satisfies GiteeBackendShape
  return attachGiteeOpUsage(backend)
}

export const giteeBackend = {
  id: 'gitee',
  label: 'Gitee',
  setupPrompt: {
    trackerLine: 'setup.gitee.trackerLine',
    trackerChoice: 'setup.gitee.trackerChoice',
    backendNote: 'setup.gitee.backendNote',
    labelReqs: 'setup.gitee.labelReqs',
  },
  describe,
  issueAddress,
  issueRefPattern,
  repoSearchAddress,
  links,
  openRepository,
  openIssue: 'url',
  openContainer: 'url',
  // Gitee 的主色是一点偏暗的红（品牌红 #c71d23）；深色主题下用亮一档的同族红，避免整块糊在一起。
  presentation: {
    color: '#c71d23',
    darkColor: '#ff6b70',
    bg: 'light-dark(rgba(199,29,35,.12), rgba(255,107,112,.14))',
    border: 'light-dark(rgba(199,29,35,.25), rgba(255,107,112,.30))',
  },
  create: createGiteeBackend,
  matches,
  budget: { kind: 'requests-only', countsRequests: true, countsPoints: false, independentBuckets: false },
  prompts,
  fixes,
} satisfies BackendModule

export default createGiteeBackend
