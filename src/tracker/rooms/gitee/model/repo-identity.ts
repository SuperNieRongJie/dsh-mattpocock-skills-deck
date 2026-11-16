/**
 * src/tracker/rooms/gitee/model/repo-identity.ts —— 从本地证据认出 gitee.com 上的 owner/name
 *
 * getRepoKey 只能读本地证据，不许问远端：它要在「还没决定用哪个后端」的时候回答
 * 「这个目录看起来绑在哪个仓库上」，问了远端就变成先认定后再验证，顺序反了。
 * 所以证据只有两样：.git/config 里的 origin 地址，和 git remote get-url origin 的输出。
 *
 * 这里也维护一张小的「目录 → 远端源」记忆表：describe 是同步函数，没法现场读文件，
 * 只能在 matches/操作期间顺手把读到的源记下来，describe 时再查。
 */
import type { OpContext } from '../../../contract/contexts.js'
import { GITEE_READ_TIMEOUT_MS } from '../../../../shared/time-config/src/values.js'
import { DEFAULT_GITEE_WEB_ORIGIN } from '../room/links.js'

export interface RepoKey {
  owner: string
  name: string
}

/** 同一主机下的仓库地址解析：支持 https、ssh://、git@host:owner/repo 三种写法。 */
export function parseGiteeRepo(url: unknown): RepoKey | null {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (!raw) return null
  let pathPart = ''
  const scp = /^[^@\/\s]+@[^:\/\s]+:(.+)$/.exec(raw)
  if (scp) {
    pathPart = scp[1]
  } else {
    const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@\/\s]+@)?[^\/\s]+\/(.*)$/i.exec(raw)
    if (scheme) pathPart = scheme[1]
    else pathPart = raw
  }
  pathPart = pathPart.split('#')[0].split('?')[0].replace(/\/+$/, '').replace(/\.git$/i, '')
  const segments = pathPart.split('/').filter((s) => s !== '')
  if (segments.length < 2) return null
  return { owner: segments[0], name: segments[segments.length - 1] }
}

/** 从仓库地址里取出网页源（协议 + 主机），去掉用户信息；认不出就回空串。 */
export function parseGiteeOrigin(url: unknown): string {
  const raw = typeof url === 'string' ? url.trim() : ''
  if (!raw) return ''
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@\/\s]+@)?([^\/\s]+)\//i.exec(raw)
  if (scheme) return scheme[1].toLowerCase() + '://' + scheme[2]
  const scp = /^[^@\/\s]+@([^:\/\s]+):/i.exec(raw)
  if (scp) return 'https://' + scp[1]
  return ''
}

const ORIGIN_CAPACITY = 200

// 为什么用 Map 且限制条数：describe 同步调用，没有别的通道把异步读到的结果带过去；
// 上限防止长时间运行的会话把每个工作目录都记一辈子。
const learnedOrigins = new Map<string, string>()

/** 记下某个工作目录的 Gitee 网页源（matches、getRepoKey 读到 origin 时调用）。 */
export function learnGiteeOrigin(cwd: string, url: unknown): void {
  const origin = parseGiteeOrigin(url)
  if (!cwd || !origin) return
  if (learnedOrigins.size >= ORIGIN_CAPACITY) {
    const oldest = learnedOrigins.keys().next()
    if (!oldest.done) learnedOrigins.delete(oldest.value)
  }
  learnedOrigins.set(cwd, origin)
}

/** describe 用的同步查询：没记过就回空串，由调用方退回默认网页源。 */
export function giteeOriginOf(cwd: string): string {
  return learnedOrigins.get(cwd) || ''
}

function parseJsonObject(text: unknown): Record<string, unknown> | null {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * 读本地证据认出仓库。
 *
 * 顺序是「先问 git（它认得 includeIf、worktree 这些写法），再退回去读 .git/config」。
 * 两条都拿不到就回 null——这里绝不允许猜一个 owner/name 出来。
 */
export async function getRepoKey(cwd: string, ctx: Partial<OpContext>): Promise<RepoKey | null> {
  try {
    const base = ctx || {}
    const execCwd = typeof cwd === 'string' && cwd.trim() ? cwd : (base.cwd || '')
    if (!execCwd) return null
    const platform = base.platform
    const execFn = base.exec
    if (platform && typeof platform.resolveExecutable === 'function' && typeof execFn === 'function') {
      try {
        const exe = await platform.resolveExecutable('git')
        if (exe) {
          const res = await execFn('git', ['-C', execCwd, 'remote', 'get-url', 'origin'], {
            cwd: execCwd,
            signal: base.signal,
            timeout: GITEE_READ_TIMEOUT_MS,
          })
          if (res && typeof res === 'object' && (res.code === 0 || res.code === undefined)) {
            const url = String(res.stdout || '').trim() || String(res.text || '').trim()
            const parsed = parseGiteeRepo(url)
            if (parsed) {
              learnGiteeOrigin(execCwd, url)
              return parsed
            }
          }
        }
      } catch {
        // 问 git 失败不致命：下面还有直接读配置文件这一条
      }
    }
    const fs = base.fs || (platform && platform.fs)
    if (fs && typeof fs.resolve === 'function' && typeof fs.readText === 'function') {
      const target = await fs.resolve('.git/config', { cwd: execCwd })
      const text = await fs.readText(target)
      const config = typeof text === 'string' ? text : ''
      if (config) {
        const block = /\[remote\s+"origin"\]([^\[]*)/i.exec(config)
        const url = block ? /url\s*=\s*([^\r\n]+)/i.exec(block[1]) : /url\s*=\s*([^\r\n]+)/i.exec(config)
        const parsed = url ? parseGiteeRepo(url[1].trim()) : null
        if (parsed) {
          if (url) learnGiteeOrigin(execCwd, url[1].trim())
          return parsed
        }
      }
    }
    return null
  } catch {
    return null
  }
}

export default { parseGiteeRepo, parseGiteeOrigin, getRepoKey, learnGiteeOrigin, giteeOriginOf }
