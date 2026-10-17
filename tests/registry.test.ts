/**
 * 仓库注册表测试 —— 确保白名单缺陷不再复现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARCHIVED_REPOS,
  REPO_REGISTRY,
  describeRepos,
  resolveRepo,
} from '../src/github/registry.ts';

test('注册表不含 LogShare 中的 404 仓库（实测缺陷回归）', () => {
  const deadRepos = [
    'Amethyst-Launcher/Amethyst',
    'Glow-Worm-Project/PojavLauncher-Glow-Worm',
    'sparrow-app/MobileGlues',
  ];
  const repos = REPO_REGISTRY.map((r) => r.repo);
  for (const dead of deadRepos) {
    assert.ok(!repos.includes(dead), `${dead} 是 404 仓库，不应出现在注册表中`);
  }
});

test('ZalithLauncher2 已注册（实测 13/27 份日志的来源，原白名单缺失）', () => {
  const r = resolveRepo('zalith');
  assert.equal(r.repo, 'ZalithLauncher/ZalithLauncher2');
  assert.equal(r.archived, false);

  assert.equal(resolveRepo('zl2').repo, 'ZalithLauncher/ZalithLauncher2');
  assert.equal(
    resolveRepo('ZalithLauncher/ZalithLauncher2').repo,
    'ZalithLauncher/ZalithLauncher2',
  );
});

test('MobileGlues 指向真实仓库 MobileGL-Dev', () => {
  assert.equal(resolveRepo('mobileglues').repo, 'MobileGL-Dev/MobileGlues-release');
  assert.equal(resolveRepo('mg').repo, 'MobileGL-Dev/MobileGlues-release');
});

test('Amethyst 指向 AngelAuraMC/Amethyst-Android', () => {
  assert.equal(resolveRepo('amethyst').repo, 'AngelAuraMC/Amethyst-Android');
  assert.equal(resolveRepo('aamc').repo, 'AngelAuraMC/Amethyst-Android');
});

test('Pojav 原仓库已归档：提示替代者', () => {
  const r = resolveRepo('PojavLauncherTeam/PojavLauncher');
  assert.equal(r.archived, true);
  assert.equal(r.replacedBy, 'MojoLauncher/MojoLauncher');
});

test('Zalith 旧仓库已归档：提示替代者', () => {
  const r = resolveRepo('ZalithLauncher/ZalithLauncher');
  assert.equal(r.archived, true);
  assert.equal(r.replacedBy, 'ZalithLauncher/ZalithLauncher2');
});

test('接受任意 owner/repo（不再限于白名单）', () => {
  const r = resolveRepo('emilyploszaj/emi');
  assert.equal(r.repo, 'emilyploszaj/emi');
  assert.equal(r.archived, false);

  assert.equal(resolveRepo('some-org/some-mod').repo, 'some-org/some-mod');
});

test('未知别名返回 null（触发全局搜索兜底）', () => {
  assert.equal(resolveRepo('unknown-launcher-xyz').repo, null);
  assert.equal(resolveRepo('').repo, null);
});

test('拒绝非法输入（防注入）', () => {
  for (const bad of ['../../etc/passwd', "a/b' OR 1=1", 'http://evil.com/x', 'a b']) {
    assert.equal(resolveRepo(bad).repo, null, `${bad} 应被拒绝`);
  }
});

test('注册表条目结构完整', () => {
  for (const r of REPO_REGISTRY) {
    assert.ok(r.alias.length > 0);
    assert.ok(r.name.length > 0);
    assert.match(r.repo, /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/);
    assert.ok(r.aliases.length > 0);
    assert.ok(r.desc.length > 0);
  }
});

test('别名不重复（避免解析歧义）', () => {
  const seen = new Map<string, string>();
  for (const r of REPO_REGISTRY) {
    // alias 是主别名，应包含在 aliases 中（解析统一走 aliases）
    assert.ok(
      r.aliases.includes(r.alias),
      `${r.repo} 的主别名 ${r.alias} 应包含在 aliases 中`,
    );
    for (const a of r.aliases) {
      const owner = seen.get(a);
      assert.equal(owner, undefined, `别名 ${a} 在 ${owner} 与 ${r.repo} 间重复`);
      seen.set(a, r.repo);
    }
  }
});

test('归档表引用的替代者都在注册表中', () => {
  const repos = new Set(REPO_REGISTRY.map((r) => r.repo));
  for (const a of ARCHIVED_REPOS) {
    assert.ok(repos.has(a.replacedBy), `替代者 ${a.replacedBy} 不在注册表中`);
  }
});

test('describeRepos 含关键提示（repo 可省略）', () => {
  const text = describeRepos();
  assert.ok(text.includes('ZalithLauncher2'));
  assert.ok(text.includes('repo` 参数可省略'));
});
