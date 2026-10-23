/**
 * 会话存储测试（MariaDB）。
 *
 * ## 隔离方式
 *
 * 每个测试文件建一个独立数据库（`tests/helpers/testdb.ts`），用完删除。
 * 原先用「每个用例一个临时 SQLite 文件」——MariaDB 下等价物就是独立库，
 * 比清表干净（不用处理自增重置与外键顺序）。
 *
 * 库不可用时**跳过**而非假绿：本地没起 MariaDB 是常态，report 里会显示 skipped。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb } from './helpers/testdb.ts';

const tdb = await createTestDb();

if (!tdb.ok) {
  test('会话存储（跳过：MariaDB 不可用）', (t) => {
    t.skip(`MariaDB 不可用：${tdb.reason ?? '未知'}。启动 mariadbd 后重跑。`);
  });
} else {
  const { migrate } = await import('../src/store/migrate.ts');
  const { closePool } = await import('../src/store/mysql.ts');
  const {
    appendMessage,
    cleanupExpired,
    countRounds,
    findOrCreateSession,
    getHistory,
    getSession,
    sessionStats,
    checkRoundsAllowed,
  } = await import('../src/store/session.ts');

  await migrate();

  test.after(async () => {
    await closePool();
    await tdb.dispose();
  });

  /** 每个用例清一次数据（同一库内的用例互不影响） */
  async function reset(): Promise<void> {
    const { execute } = await import('../src/store/mysql.ts');
    await execute('DELETE FROM log_bodies');
    await execute('DELETE FROM messages');
    await execute('DELETE FROM sessions');
  }

  test('创建会话', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600);
    assert.ok(s.id.startsWith('s'));
    assert.equal(s.logId, null);
    assert.equal(s.logKind, 'native');
    assert.ok(s.expiresAt > s.createdAt);
  });

  test('按 ID 取回会话', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600);
    const got = await getSession(s.id);
    assert.equal(got?.id, s.id);
  });

  test('过期会话取不到', async () => {
    await reset();
    const s = await findOrCreateSession(null, -1); // 立即过期
    assert.equal(await getSession(s.id), null);
  });

  test('同一 owner + logId 复用会话', async () => {
    await reset();
    const a = await findOrCreateSession('kalkLqQ', 3600, 'owner-1', 'logshare');
    const b = await findOrCreateSession('kalkLqQ', 3600, 'owner-1', 'logshare');
    assert.equal(a.id, b.id, '同一主体应复用');
    assert.equal(a.logKind, 'logshare');
  });

  test('不同 owner 不复用（避免串会话）', async () => {
    await reset();
    const a = await findOrCreateSession('kalkLqQ', 3600, 'owner-1', 'logshare');
    const b = await findOrCreateSession('kalkLqQ', 3600, 'owner-2', 'logshare');
    assert.notEqual(a.id, b.id);
  });

  test('无 owner 时不自动复用', async () => {
    await reset();
    const a = await findOrCreateSession('kalkLqQ', 3600, null, 'logshare');
    const b = await findOrCreateSession('kalkLqQ', 3600, null, 'logshare');
    assert.notEqual(a.id, b.id);
  });

  test('追加消息并读取历史', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600);
    await appendMessage(s.id, 'user', '第一个问题');
    await appendMessage(s.id, 'assistant', '第一个回答', { reasoning: '思考过程' });

    const hist = await getHistory(s.id, 10);
    assert.equal(hist.length, 2);
    assert.equal(hist[0]?.role, 'user');
    assert.equal(hist[1]?.content, '第一个回答');
    assert.equal(hist[1]?.reasoning, '思考过程');
  });

  test('消息带 score 与 meta 能原样读回', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600);
    const score = {
      overall: 92,
      deliverable: true,
      dimensions: { grounding: 80, verification: 100, actionability: 100, economy: 90 },
      deductions: ['少一条引用'],
      missingAnchors: ['libc.so'],
    };
    const meta = { asks: [{ questions: ['手机型号？'], reason: '缺设备信息' }] };

    await appendMessage(s.id, 'assistant', '回答', { score, meta });

    const hist = await getHistory(s.id, 10);
    assert.equal(hist[0]?.score?.overall, 92);
    assert.deepEqual(hist[0]?.score?.missingAnchors, ['libc.so']);
    assert.equal(hist[0]?.meta?.asks?.[0]?.questions[0], '手机型号？');
  });

  test('轮次计数只算 user（一轮 = 一次提问）', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600);
    await appendMessage(s.id, 'user', 'q1');
    await appendMessage(s.id, 'assistant', 'a1');
    await appendMessage(s.id, 'user', 'q2');
    assert.equal(await countRounds(s.id), 2);
  });

  test('轮次上限检查', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600);
    const first = await checkRoundsAllowed(s.id);
    assert.equal(first.allowed, true);
    assert.ok(first.remaining > 0);
  });

  test('清理过期会话连带删除消息', async () => {
    await reset();
    const s = await findOrCreateSession(null, -1);
    await appendMessage(s.id, 'user', '会被清理');
    const removed = await cleanupExpired();
    assert.ok(removed >= 1);
    assert.equal(await getSession(s.id), null);
  });

  test('统计接口可用', async () => {
    await reset();
    await findOrCreateSession(null, 3600);
    const st = await sessionStats();
    assert.equal(st.sessions, 1);
  });

  test('会话 TTL：绑定 LogShare 日志时跟随 7 天', async () => {
    const { sessionTtlSeconds } = await import('../src/store/session.ts');
    const bound = sessionTtlSeconds('kalkLqQ');
    const free = sessionTtlSeconds(null);
    assert.ok(bound > free, '绑定日志的会话应比独立会话活得久');
    assert.equal(bound, 7 * 24 * 3600);
  });
}
