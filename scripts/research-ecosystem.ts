/**
 * 生态现状研究 —— 扫描启动器/渲染器仓库的高频问题，为知识库扩充提供依据。
 *
 * 用法: GITHUB_TOKENS=xxx npx tsx scripts/research-ecosystem.ts
 */
import { REPO_REGISTRY } from '../src/github/registry.ts';

interface IssueItem {
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  comments: number;
  labels: Array<{ name: string }>;
  body: string | null;
}

async function gh(path: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKENS?.split(',')[0]?.trim();
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'LogRAG-Research/0.1',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${path}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

/** 提取问题标题中的关键信号（错误类型、组件名） */
const SIGNALS: Array<[string, RegExp]> = [
  ['crash', /crash|崩溃/i],
  ['sigsegv', /sigsegv|signal 11|段错误/i],
  ['unsatisfied-link', /UnsatisfiedLinkError|dlopen|Failed to load a library|找不到.*\.so/i],
  ['no-class-def', /NoClassDefFoundError|ClassNotFoundException/i],
  ['no-such-method', /NoSuchMethodError|NoSuchFieldError|IncompatibleClassChangeError/i],
  ['mixin', /mixin/i],
  ['out-of-memory', /OutOfMemory|内存不足|OOM/i],
  ['java-version', /java.*version|UnsupportedClassVersion|Java 1[78]|Java 2[15]/i],
  ['sdl', /SDL/i],
  ['lwjgl', /lwjgl|glfw/i],
  ['renderer', /renderer|渲染器|gl4es|mobileglues|angle|zink|turnip|virgl|mesa/i],
  ['shader', /shader|光影|shaderpack|iris|oculus|optifine/i],
  ['mod-dep', /depend|前置|HARD_DEP|missing.*mod/i],
  ['auth', /401|auth|credential|登录|账号/i],
  ['graphics-driver', /driver|驱动|mali|adreno|exynos|kirin|snapdragon|dimensity/i],
  ['fabric', /fabric/i],
  ['forge', /forge(?!.*neo)/i],
  ['neoforge', /neoforge/i],
  ['launcher-self', /launcher.*crash|启动器.*崩溃|launcher problem/i],
];

async function main(): Promise<void> {
  const out: Record<string, unknown> = {};

  console.log('═══ 生态现状扫描 ═══\n');

  for (const entry of REPO_REGISTRY) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`【${entry.name}】${entry.repo}`);
    console.log('='.repeat(70));

    try {
      // 最近 100 条 issues（含 PR），按更新时间降序
      const issues = (await gh(
        `/repos/${entry.repo}/issues?state=all&per_page=100&sort=updated&direction=desc`,
      )) as IssueItem[];

      const signalCount = new Map<string, number>();
      const recentTitles: string[] = [];

      for (const it of issues) {
        if ((it as unknown as { pull_request?: unknown }).pull_request) continue; // 只要 issue
        const text = `${it.title}\n${(it.body ?? '').slice(0, 2000)}`;
        for (const [name, re] of SIGNALS) {
          if (re.test(text)) {
            signalCount.set(name, (signalCount.get(name) ?? 0) + 1);
          }
        }
        if (it.state === 'open' && recentTitles.length < 12) {
          recentTitles.push(`#${it.number} ${it.title.slice(0, 90)}`);
        }
      }

      const sorted = [...signalCount.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`\n高频信号（基于最近 ${issues.length} 条，仅统计 issue）：`);
      for (const [name, count] of sorted.slice(0, 12)) {
        console.log(`  ${name.padEnd(20)} ${count}`);
      }

      console.log(`\n最近更新的 open issues：`);
      for (const t of recentTitles) console.log(`  ${t}`);

      out[entry.repo] = {
        total: issues.length,
        signals: Object.fromEntries(sorted),
        recentOpen: recentTitles,
      };
    } catch (e) {
      console.log(`  扫描失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 全局检索：跨仓库的通用问题
  console.log(`\n\n${'='.repeat(70)}`);
  console.log('【全局检索】跨仓库的高频故障签名');
  console.log('='.repeat(70));

  const globalQueries = [
    'SDL3 26.3 snapshot launcher',
    'UnsatisfiedLinkError liblwjgl arm64',
    'MobileGlues SIGSEGV',
    'launcher crash GLFW init',
    'Java 25 Minecraft Android',
  ];

  for (const q of globalQueries) {
    try {
      const r = (await gh(
        `/search/issues?q=${encodeURIComponent(q)}&per_page=5&sort=updated&order=desc`,
      )) as { total_count: number; items: Array<IssueItem & { repository_url: string }> };

      console.log(`\n"${q}" → ${r.total_count} 条`);
      for (const it of r.items.slice(0, 5)) {
        const repo = it.repository_url.replace('https://api.github.com/repos/', '');
        console.log(`  [${repo}#${it.number}] ${it.title.slice(0, 80)}`);
      }
    } catch (e) {
      console.log(`  失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log('\n\n完成。');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
