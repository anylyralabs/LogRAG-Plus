/**
 * GitHub 仓库注册表 —— 修正实测发现的 4/6 失效问题。
 *
 * ## 实测发现（27 份日志，GitHub API 逐个核验）
 * LogShare 现有白名单 6 个仓库中 **4 个不可用**：
 *  - `Amethyst-Launcher/Amethyst`         → 404
 *  - `Glow-Worm-Project/PojavLauncher-Glow-Worm` → 404
 *  - `sparrow-app/MobileGlues`            → 404（服务端实录 422 Validation Failed）
 *  - `PojavLauncherTeam/PojavLauncher`    → 已归档（2025-09-23）
 *
 * 而 ZalithLauncher（实测 13/27 份日志的来源）**完全不在白名单**。
 *
 * ## 修正
 * 1. 全部替换为核验过的真实仓库
 * 2. 新增 `resolveRepo` 失败时的候选提示（用全局仓库搜索）
 * 3. 支持无 `repo` 的全局 issue 检索（实测：一次搜索命中 5 个启动器的解法）
 */

export interface RepoEntry {
  /** 别名（用于 resolveRepo 匹配） */
  alias: string;
  /** 展示名 */
  name: string;
  /** owner/repo */
  repo: string;
  /** 其他可识别的写法 */
  aliases: string[];
  /** 适用场景描述（供模型判断） */
  desc: string;
  /** 是否活跃（核验时间 2026-10-15） */
  status: 'active' | 'archived';
}

/**
 * 核验过的仓库注册表。
 *
 * 每个仓库都用 GitHub API 核验过 full_name / stars / pushed_at / archived。
 */
export const REPO_REGISTRY: ReadonlyArray<RepoEntry> = [
  {
    alias: 'zalith',
    name: 'ZalithLauncher2',
    repo: 'ZalithLauncher/ZalithLauncher2',
    aliases: ['zalith', 'zalithlauncher', 'zl2', 'zalith-launcher', 'zl'],
    desc: 'Android 移动端启动器（ZalithLauncher 2），Pojav 系继任分支；实测中为移动端日志最主要来源',
    status: 'active',
  },
  {
    alias: 'fcl',
    name: 'FoldCraftLauncher',
    repo: 'FCL-Team/FoldCraftLauncher',
    aliases: ['fcl', 'foldcraft', 'foldcraftlauncher', 'fold-craft-launcher'],
    desc: 'Android 平台移动端启动器，涵盖 Java 运行时安装、触控布局、模组配置等问题',
    status: 'active',
  },
  {
    alias: 'mobileglues',
    name: 'MobileGlues',
    repo: 'MobileGL-Dev/MobileGlues-release',
    aliases: ['mobileglues', 'mg', 'mobile-glues', 'mobileglues-release'],
    desc: '移动端渲染桥接组件（GL→GLES 转译），处理图形崩溃、着色器报错与光影兼容性问题',
    status: 'active',
  },
  {
    alias: 'amethyst',
    name: 'Amethyst-Android',
    repo: 'AngelAuraMC/Amethyst-Android',
    aliases: ['amethyst', 'aamc', 'amethyst-android', 'amethyst-launcher'],
    desc: '紫水晶启动器（AAMC），Pojav 系另一分支；SDL3 与新版 MC 适配的先行实现',
    status: 'active',
  },
  {
    alias: 'mojo',
    name: 'MojoLauncher',
    repo: 'MojoLauncher/MojoLauncher',
    aliases: ['mojo', 'mojolauncher', 'mojo-launcher'],
    desc: 'PojavLauncher 的活跃继任分支（原 PojavLauncherTeam/PojavLauncher 已于 2025-09 归档）',
    status: 'active',
  },
  {
    alias: 'pgw',
    name: 'Pojav-Glow-Worm',
    repo: 'Vera-Firefly/Pojav-Glow-Worm',
    aliases: ['pgw', 'glowworm', 'pojav-glow-worm', 'pojavglowworm'],
    desc: '移动端 Pojav 增强分支，主打扩展渲染器支持与运行优化',
    status: 'active',
  },
  {
    alias: 'hmcl',
    name: 'Hello Minecraft! Launcher',
    repo: 'HMCL-dev/HMCL',
    aliases: ['hmcl', 'hellominecraftlauncher'],
    desc: '跨平台桌面启动器，涵盖 Fabric/Forge 安装器故障、Java 下载与账号授权',
    status: 'active',
  },
];

/** 已归档仓库：命中时给出明确提示，避免模型基于停更内容下结论 */
export const ARCHIVED_REPOS: ReadonlyArray<{ repo: string; replacedBy: string }> = [
  {
    repo: 'PojavLauncherTeam/PojavLauncher',
    replacedBy: 'MojoLauncher/MojoLauncher',
  },
  {
    repo: 'ZalithLauncher/ZalithLauncher',
    replacedBy: 'ZalithLauncher/ZalithLauncher2',
  },
];

export interface ResolveResult {
  /** 解析成功时的 owner/repo */
  repo: string | null;
  /** 是否为已归档仓库（提示模型注意时效） */
  archived: boolean;
  /** 归档仓库的替代者 */
  replacedBy?: string;
}

const OWNER_REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;

/**
 * 解析仓库输入为 owner/repo。
 *
 * 与 LogShare 的差异：**不再拒绝未知仓库名**——直接透传合法 owner/repo 格式，
 * 并允许调用方在解析失败时走全局搜索（见 githubSearch）。
 */
export function resolveRepo(input: string): ResolveResult {
  const trimmed = input.trim();
  if (trimmed === '') return { repo: null, archived: false };

  const lower = trimmed.toLowerCase();

  // 已归档仓库：明确提示
  for (const entry of ARCHIVED_REPOS) {
    if (entry.repo.toLowerCase() === lower) {
      return { repo: entry.repo, archived: true, replacedBy: entry.replacedBy };
    }
  }

  // 注册表匹配（别名 / 展示名 / 仓库名）
  for (const entry of REPO_REGISTRY) {
    if (entry.repo.toLowerCase() === lower) return { repo: entry.repo, archived: false };
    if (entry.name.toLowerCase() === lower) return { repo: entry.repo, archived: false };
    if (entry.aliases.includes(lower)) return { repo: entry.repo, archived: false };
  }

  // owner/repo 格式：直接接受（不再要求在白名单内）
  if (OWNER_REPO.test(trimmed)) return { repo: trimmed, archived: false };

  return { repo: null, archived: false };
}

/** 生成注册表清单文本（供 github_list_repos 工具返回） */
export function describeRepos(): string {
  const lines = ['# 已知的 Minecraft 启动器与渲染器仓库（已核验，2026-10-15）：', ''];
  for (const r of REPO_REGISTRY) {
    lines.push(`- **${r.name}**（仓库: \`${r.repo}\`，别名: ${r.aliases.join(', ')}）`);
    lines.push(`  适用场景: ${r.desc}`);
  }
  lines.push('');
  lines.push('提示：');
  lines.push('- `repo` 参数可省略；省略时会在 GitHub 全站检索 Issues/PRs，适合不知道仓库名的场景。');
  lines.push('- 也可直接传 `owner/repo` 形式的任意仓库，不限于上表。');
  return lines.join('\n');
}
