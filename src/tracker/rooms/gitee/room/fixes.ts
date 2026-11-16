/**
 * src/tracker/rooms/gitee/room/fixes.ts —— 三类典型故障的修复动作
 *
 * 键名 gitee:installed / gitee:authed / gitee:repoAccess 是识别链与界面共用的外部契约：
 * 识别链在预检某一关失败时给出这个键，界面按这个键渲染按钮。改名会让「修一下」按钮消失。
 *
 * 每个动作只做它说的事：前两个把对应的说明注入对话并刷新识别链，第三个走建仓向导、
 * 提交后调用契约里的 initProject。动作里不写具体命令，免得两处说法不一致。
 */
export const fixes = Object.freeze({
  'gitee:installed': {
    hint: {
      zh: '这台机器上找不到 gitee 命令，房间无法访问 Gitee。',
      en: 'The gitee command was not found on this machine, so the room cannot reach Gitee.',
    },
    actions: [
      {
        type: 'inject-prompt',
        prompt: 'giteeInstallFix',
        label: { zh: '安装指引', en: 'Install guide' },
      },
      { type: 'refresh', target: 'chain' },
    ],
  },
  'gitee:authed': {
    hint: {
      zh: 'gitee 命令在，但没有可用的登录态。',
      en: 'The gitee command exists, but there is no usable login state.',
    },
    actions: [
      {
        type: 'inject-prompt',
        prompt: 'giteeLoginFix',
        label: { zh: '登录指引', en: 'Login guide' },
      },
      { type: 'refresh', target: 'chain' },
    ],
  },
  'gitee:repoAccess': {
    hint: {
      zh: '登录态可用，但这个账号看不到目标仓库，或者还没有仓库。',
      en: 'The login state works, but this account cannot see the target repository, or the repository does not exist yet.',
    },
    actions: [
      {
        type: 'wizard',
        label: { zh: '创建并发布', en: 'Create & publish' },
        steps: [
          {
            title: { zh: '仓库信息', en: 'Repository info' },
            schema: [
              {
                name: 'name',
                type: 'text',
                required: true,
                label: { zh: '仓库名', en: 'Repository name' },
                pattern: '^[A-Za-z0-9._-]{1,100}$',
                defaultFrom: 'cwd-basename',
                preview: { zh: '将创建 https://gitee.com/{owner}/{name}', en: 'Will create https://gitee.com/{owner}/{name}' },
              },
            ],
          },
          {
            title: { zh: '可见性', en: 'Visibility' },
            schema: [
              {
                name: 'visibility',
                type: 'single',
                label: { zh: '可见性', en: 'Visibility' },
                options: ['private', 'public'],
                optionSubs: {
                  private: { zh: '仅自己', en: 'Only you' },
                  public: { zh: '所有人', en: 'Everyone' },
                },
                defaultValue: 'private',
              },
            ],
          },
        ],
        submitAction: { type: 'contract-op', op: 'initProject', params: {} },
      },
      { type: 'refresh', target: 'chain' },
    ],
  },
})

export default fixes
