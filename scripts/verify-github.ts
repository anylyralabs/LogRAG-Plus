/**
 * GitHub 客户端真实 API 验证 —— 复现实测中失败的场景。
 *
 * 用法: GITHUB_TOKENS=xxx npx tsx scripts/verify-github.ts
 */
import { getContent, search, searchRepositories } from '../src/github/client.ts';

async function main(): Promise<void> {
  console.log('═══ GitHub 客户端验证（复现实测失败场景）═══\n');

  // 场景 1：实测中模型不知道 Zalith 仓库名，只能猜 → 白名单没有 → 失败
  console.log('【场景 1】实测失败点：不知道仓库名，且白名单无 Zalith');
  console.log('  修复前: github_search(repo="ZalithLauncher") → 未找到对应的仓库（预算 -1）');
  console.log('  修复后: 省略 repo，全局检索 SDL3 26.3\n');

  const global = await search('SDL3 26.3 snapshot', { maxResults: 5 });
  console.log(global.text.split('\n').slice(0, 18).join('\n'));
  console.log('\n' + '─'.repeat(70) + '\n');

  // 场景 2：不知道仓库名时，用关键词搜仓库
  console.log('【场景 2】用关键词查找仓库');
  const repos = await searchRepositories('ZalithLauncher', 4);
  console.log(repos.text);
  console.log('\n' + '─'.repeat(70) + '\n');

  // 场景 3：读取实测中"本该拿到"的答案
  console.log('【场景 3】读取 ZalithLauncher2 的 PR #1721（实测中的精确答案）');
  const pr = await getContent({ repo: 'ZalithLauncher/ZalithLauncher2', number: 1721 });
  console.log(pr.text.split('\n').slice(0, 22).join('\n'));
  console.log('\n' + '─'.repeat(70) + '\n');

  // 场景 4：已归档仓库的提示
  console.log('【场景 4】已归档仓库应给出替代提示');
  const archived = await search('SDL', { repo: 'PojavLauncherTeam/PojavLauncher', maxResults: 3 });
  console.log(archived.text.split('\n').slice(0, 6).join('\n'));
  console.log('\n' + '─'.repeat(70) + '\n');

  // 场景 5：MobileGlues 真实仓库检索（实测中 sparrow-app 是 404）
  console.log('【场景 5】MobileGlues 真实仓库检索（原白名单 sparrow-app/MobileGlues 为 404）');
  const mg = await search('SIGSEGV', { repo: 'mobileglues', maxResults: 3 });
  console.log(mg.text.split('\n').slice(0, 14).join('\n'));
}

main().catch((e) => {
  console.error('验证失败:', e);
  process.exit(1);
});
