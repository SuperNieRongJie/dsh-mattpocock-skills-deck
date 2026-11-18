/**
 * src/tracker/rooms/gitee/support/label-alias.ts —— Gitee 标签名的远端别名
 *
 * 契约与 deck 面板统一用带半角冒号的 canonical 标签名（`wayfinder:map` 等），
 * 但 Gitee 的标签管理接口不接受半角冒号（只收汉字、字母、数字与 `.`、`_`、`-`、
 * `/`、`\` 以及全角符号），所以仓库里实际存在的标签是把冒号换成中划线的
 * `wayfinder-map` 这一组名字。
 *
 * 两边必须在一处对账，否则会出现三种坏结果：列表按一个不存在的标签筛、建票时
 * 远端静默丢弃不认识的标签、改色请求打到不存在的标签名上。把换算集中在这里，
 * 读侧与写侧都只认一套名字，别的房（GitHub、GitLab、本地 Markdown）不受影响。
 *
 * 约定：只翻译下面这五枚 wayfinder 标签，其他标签原样返回。这五枚是 deck 自己
 * 会写、会筛、会改色的全部标签；不扩大映射面，是为了避免某个普通标签恰好叫
 * 某个别名时被悄悄改写。
 */

/** 地图标签的 canonical 名；写侧补标签、读侧判类型都以它为准。 */
export const WAYFINDER_MAP_LABEL = 'wayfinder:map'

/** 需要在中划线名与 canonical 名之间换算的五枚标签。 */
const WAYFINDER_LABELS = [
  'wayfinder:map',
  'wayfinder:research',
  'wayfinder:prototype',
  'wayfinder:grilling',
  'wayfinder:task',
] as const

const REMOTE_BY_CANONICAL = new Map<string, string>(WAYFINDER_LABELS.map((name) => [name, name.replace(':', '-')]))
const CANONICAL_BY_REMOTE = new Map<string, string>(WAYFINDER_LABELS.map((name) => [name.replace(':', '-'), name]))

/**
 * canonical 名 → Gitee 上真实存在的名字。
 *
 * 只做精确匹配：调用方传进来的名字通常已经 trim 过；不在这里 trim 或转小写，
 * 是因为「Wayfinder-Map」这类人手工建的标签与真实标签并不相同，替调用方改写
 * 会把一个本来就不存在的标签说成存在。
 */
export function toRemote(name: string): string {
  return REMOTE_BY_CANONICAL.get(name) ?? name
}

/** Gitee 上真实存在的名字 → canonical 名；不认识的名字原样返回。 */
export function toCanonical(name: string): string {
  return CANONICAL_BY_REMOTE.get(name) ?? name
}

/**
 * 这枚标签是不是地图标签。
 *
 * 两种写法都认：远端回包可能是中划线名，内存里经过 normalize 之后已经是
 * canonical 名；两种都判成地图，调用方不用知道自己手里是哪一套。
 */
export function isMapLabel(name: string): boolean {
  const lowered = String(name == null ? '' : name).trim().toLowerCase()
  return toCanonical(lowered) === WAYFINDER_MAP_LABEL
}

/**
 * 把逗号分隔的标签名整串翻成远端名。
 *
 * 列表过滤的 labels 参数是一个逗号串，只能整串翻译；空串保持空串，
 * 让 buildListQuery 继续按「没给过滤条件」处理。
 */
export function labelsToRemote(labels: string): string {
  return String(labels == null ? '' : labels)
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map(toRemote)
    .join(',')
}
