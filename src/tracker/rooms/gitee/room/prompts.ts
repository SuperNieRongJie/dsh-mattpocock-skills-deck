/**
 * src/tracker/rooms/gitee/room/prompts.ts —— 用户撞上 Gitee 房间问题时要看到的说明文字
 *
 * 键名是外部契约（界面按名字取词条、修复动作按名字注入提示），改名等于让那几处静默空白。
 * 中文与英文两版必须说同一件事；安装与登录只给官方途径，不替用户发明命令。
 */
const giteeInstallCopy = {
  zh: 'Gitee 房间通过官方 CLI（npm 包 @gitee/gitee-cli，命令名 gitee）访问仓库。请按官方文档安装，装好后执行 gitee --version 确认命令可用。',
  en: 'The Gitee room talks to Gitee through the official CLI (npm package @gitee/gitee-cli, command name gitee). Install it following the official documentation, then run gitee --version to confirm the command is available.',
}

const giteeLoginCopy = {
  zh: '请先执行 gitee auth login 完成登录，再用 gitee auth status 确认登录态。本房不会代你输入或保存令牌。',
  en: 'Run gitee auth login first, then confirm the login state with gitee auth status. This room never enters or stores your token for you.',
}

export const prompts = {
  commandVocabulary: { cli: 'gitee', cliBrand: 'Gitee' },
  giteeInstallFix: { ...giteeInstallCopy },
  giteeLoginFix: { ...giteeLoginCopy },
  cliInstall: { ...giteeInstallCopy },
  cliLogin: { ...giteeLoginCopy },
  giteeRepoFix: {
    zh: '当前登录人看不到这个仓库，或者仓库标识不是 owner/repo 两段。请确认仓库地址，并确认这个账号在 Gitee 上有该仓库的读权限；没有仓库时可以先用「创建并发布」建一个。',
    en: 'The signed-in account cannot see this repository, or the repository reference is not in owner/repo form. Check the repository address and this account read permission on Gitee; if the repository does not exist yet, create one with "Create & publish".',
  },
  subIssue: {
    zh: '子票来自远端票面上 parent_id 指向这张地图的票。Gitee 只给父票的数字 id，读回时只有 parent_url 尾段是非数字票号才能填进 parentKey；填不上的行会留一行退化日志，不会编一个数字当票号。',
    en: 'Sub-issues are the remote issues whose parent_id points at this map. Gitee only exposes the numeric parent id, so parentKey is filled only when the tail of parent_url is a non-numeric issue key; rows that cannot be filled leave a degraded log line instead of inventing a numeric key.',
  },
  healthCheck: {
    zh: '自查顺序：gitee --version（装了没）→ gitee auth status（登录了没）→ gitee api /repos/{owner}/{repo}（这个仓库看不看得到）。三步都过还失败，再看 read.degraded 日志里记的是哪一步。',
    en: 'Check in order: gitee --version (installed?), gitee auth status (signed in?), gitee api /repos/{owner}/{repo} (can this account see the repository?). If all three pass and calls still fail, read the read.degraded log line naming the failing step.',
  },
}

export default prompts
