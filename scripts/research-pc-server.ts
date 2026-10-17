/**
 * PC 端启动器 + 服务端 现状扫描。
 *
 * 用法: GITHUB_TOKENS=xxx npx tsx scripts/research-pc-server.ts
 */

interface IssueItem {
  number: number;
  title: string;
  state: string;
  created_at: string;
  updated_at: string;
  comments: number;
  labels: Array<{ name: string }>;
  body: string | null;
  repository_url?: string;
  pull_request?: unknown;
}

/** PC 端启动器 + 服务端核心 */
const TARGETS: Array<{ name: string; repo: string; kind: 'launcher' | 'server' }> = [
  // PC 启动器
  { name: 'HMCL', repo: 'HMCL-dev/HMCL', kind: 'launcher' },
  { name: 'PrismLauncher', repo: 'PrismLauncher/PrismLauncher', kind: 'launcher' },
  { name: 'MultiMC', repo: 'MultiMC/MultiMC5', kind: 'launcher' },
  { name: 'ATLauncher', repo: 'ATLauncher/ATLauncher', kind: 'launcher' },
  { name: 'PCL2', repo: 'Hex-Dragon/PCL2', kind: 'launcher' },
  // 服务端
  { name: 'PaperMC', repo: 'PaperMC/Paper', kind: 'server' },
  { name: 'Purpur', repo: 'PurpurMC/Purpur', kind: 'server' },
  { name: 'Folia', repo: 'PaperMC/Folia', kind: 'server' },
  { name: 'Velocity', repo: 'PaperMC/Velocity', kind: 'server' },
  { name: 'GeyserMC', repo: 'GeyserMC/Geyser', kind: 'server' },
  { name: 'Fabric Server', repo: 'FabricMC/fabric-loader', kind: 'server' },
  { name: 'NeoForge', repo: 'neoforged/NeoForge', kind: 'server' },
  // 代理/网络
  { name: 'Waterfall/BungeeCord', repo: 'SpigotMC/BungeeCord', kind: 'server' },
];

const SIGNALS: Array<[string, RegExp]> = [
  ['crash', /crash|崩溃|exception/i],
  ['mod-dep', /depend|missing.*mod|前置|HARD_DEP/i],
  ['java-version', /java.*version|UnsupportedClassVersion|Java 1[78]|Java 2[15]/i],
  ['memory', /OutOfMemory|OOM|heap|内存/i],
  ['tps-lag', /tps|lag|卡顿|延迟|tick/i],
  ['chunk', /chunk|区块/i],
  ['world-corrupt', /corrupt|损坏|region/i],
  ['auth', /auth|login|401|登录|session/i],
  ['network', /connection|timeout|refused|连接|超时/i],
  ['plugin', /plugin|插件/i],
  ['proxy', /proxy|velocity|bungee|代理/i],
  ['port', /port|端口|bind/i],
  ['permission', /permission|权限|op\b/i],
  ['modloader-mismatch', /mismatch|不匹配|incompatible/i],
  ['mixin', /mixin/i],
  ['forge', /forge(?!.*neo)/i],
  ['neoforge', /neoforge/i],
  ['fabric', /fabric/i],
  ['paper', /paper|spigot|bukkit/i],
  ['datapack', /datapack|数据包/i],
];

async function gh(path: string): Promise<unknown> {
  const token = process.env.GITHUB_TOKENS?.split(',')[0]?.trim();
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'LogRAG-Research/0.1',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function main(): Promise<void> {
  for (const t of TARGETS) {
    console.log(`\n${'='.repeat(74)}`);
    console.log(`【${t.name}】(${t.kind}) ${t.repo}`);
    console.log('='.repeat(74));

    try {
      const issues = (await gh(
        `/repos/${t.repo}/issues?state=all&per_page=100&sort=updated&direction=desc`,
      )) as IssueItem[];

      const counts = new Map<string, number>();
      const openTitles: string[] = [];

      for (const it of issues) {
        if (it.pull_request) continue;
        const text = `${it.title}\n${(it.body ?? '').slice(0, 1500)}`;
        for (const [name, re] of SIGNALS) {
          if (re.test(text)) counts.set(name, (counts.get(name) ?? 0) + 1);
        }
        if (it.state === 'open' && openTitles.length < 8) {
          openTitles.push(`#${it.number} ${it.title.slice(0, 82)}`);
        }
      }

      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      console.log('高频信号:');
      for (const [name, n] of sorted.slice(0, 10)) {
        console.log(`  ${name.padEnd(20)} ${n}`);
      }
      console.log('最近 open issues:');
      for (const s of openTitles) console.log(`  ${s}`);
    } catch (e) {
      console.log(`  失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
