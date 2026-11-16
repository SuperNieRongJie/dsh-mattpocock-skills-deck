/**
 * src/tracker/rooms/gitee/support/json.ts —— Gitee 房共用的回包收尾小工具
 *
 * 为什么单独一个文件：Gitee 的 REST 调用全部经 `gitee api` 起进程，回包是一段 stdout 文本。
 * 房间里每一处读都要做同样两件事——把 stdout 解成 JSON、把任意错误值收成一句人话。
 * 写两遍就会有一天两处对「空串算什么」「回包不是 JSON 时原文取哪一段」给出不同答案，
 * 所以这两件小事只在这里写一次。
 *
 * 这里不做判档、不记日志、不构造失败结果：判档归 errors.ts，失败结果归调用点用 fail(...) 构造。
 */

/** 把一段 stdout 文本解成 JSON；不是合法 JSON（含空串）一律回 null。 */
export function parseJsonSafe(text: unknown): unknown {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * 把任意错误值收成一句能给人看的原文。
 *
 * 进程结果对象（{stdout,stderr,code}）优先用 stderr，其次 stdout；Error 用 message；
 * 其余值用 String 收尾。这里只负责「可读」，不负责判断它该归哪一档。
 */
export function errMsg(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (typeof err === 'object') {
    const bag = err as Record<string, unknown>
    const stderr = typeof bag['stderr'] === 'string' ? bag['stderr'].trim() : ''
    if (stderr) return stderr
    const stdout = typeof bag['stdout'] === 'string' ? bag['stdout'].trim() : ''
    if (stdout) return stdout
    const message = typeof bag['message'] === 'string' ? bag['message'].trim() : ''
    if (message) return message
  }
  try {
    return String(err)
  } catch {
    return ''
  }
}

/** 回包是不是一个键值袋（排除 null、数组、标量）。 */
export function isBag(raw: unknown): raw is Record<string, unknown> {
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw)
}

export default { parseJsonSafe, errMsg, isBag }
