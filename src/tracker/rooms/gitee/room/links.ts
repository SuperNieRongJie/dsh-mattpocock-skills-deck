/**
 * src/tracker/rooms/gitee/room/links.ts —— Gitee 的网页地址、搜索地址与链接模板
 *
 * 房间只产出「给人点开看」的地址，不产出 API 地址：API 路径归 queries.ts，那里从 /repos 起写。
 * 这一份的默认网页源是 https://gitee.com；如果仓库声明了自建源（host），优先用声明的那一个。
 *
 * 链接模板是外部契约（别的模块按这些字符串拼链接），四个键的名字与其它房逐字一致，不要改。
 */
import type { RepositoryRef } from '../../../contract/entities.js'

export const DEFAULT_GITEE_WEB_ORIGIN = 'https://gitee.com'

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * 取仓库的网页源：先看仓库自己声明的 host，再从 url 里解析协议与主机，最后退回默认源。
 * 只声明 host（不带协议）时按 https 补全——Gitee 的网页入口没有 http 的用法。
 */
function refOrigin(ref: Partial<RepositoryRef> | null | undefined): string {
  const declared = str(ref && ref.host).replace(/\/+$/, '')
  if (declared) return /^[a-z][a-z0-9+.-]*:\/\//i.test(declared) ? declared : 'https://' + declared
  const url = str(ref && ref.url)
  const match = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@\/\s]+@)?([^\/\s]+)\//i.exec(url)
  if (match) return match[1].toLowerCase() + '://' + match[2]
  return DEFAULT_GITEE_WEB_ORIGIN
}

/** 单张票的网页地址：https://gitee.com/{owner}/{repo}/issues/{票号}。 */
export function issueAddress(ref: Partial<RepositoryRef> | null | undefined, key: string): string {
  const refId = str(ref && ref.refId)
  if (!refId) return ''
  return refOrigin(ref) + '/' + refId + '/issues/' + String(key == null ? '' : key)
}

/** 仓库内搜索的网页地址；Gitee 的搜索参数名是 q。 */
export function repoSearchAddress(name: string, ref?: Partial<RepositoryRef> | null): string {
  return refOrigin(ref) + '/search?q=' + encodeURIComponent(String(name || ''))
}

/** 从任意文本里认出 Gitee 票地址的票号；票号是字母数字串（形如 I8A2BC）。 */
export const issueRefPattern = /gitee\.com\/[^\/\s]+\/[^\/\s]+\/issues\/([A-Za-z0-9]+)/g

export const links = {
  issueUrlTemplate: 'https://gitee.com/{refId}/issues/{key}',
  repoUrlTemplate: 'https://gitee.com/{refId}',
  searchUrlTemplate: 'https://gitee.com/search?q={q}',
  linkPatternSource: 'gitee\\.com\\/[^\\/\\s]+\\/[^\\/\\s]+\\/issues\\/([A-Za-z0-9]+)',
}

export default { issueAddress, repoSearchAddress, issueRefPattern, links, DEFAULT_GITEE_WEB_ORIGIN }
