/**
 * `GET /v1/log/{id}` 测试（本地存储路径）。
 *
 * ## 架构改革后的语义
 *
 * 正文默认存在**本服务自己的 MariaDB**（`log_bodies`），ID 就是会话 ID。
 * LogShare 只在「导入日志」时作为兜底来源。
 *
 * 因此这个端点现在守的是：
 *  1. ID 形态校验（会话 ID 与 LogShare 七位 ID 都接受，其它拒绝）
 *  2. 主日志 + 追加段的合并顺序与分隔标记
 *  3. 截断如实回报（`truncated` / `omitted`）
 *  4. 缓存：成功结果缓存，失败不缓存
 *
 * 旧的「内部 API 优先 / 公网 raw 兜底」那套断言已删除——那条内部路径
 * 从未在 LogShare 侧实现过（`/v1/internal/log/{id}` 不存在）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';

import { createTestDb } from './helpers/testdb.ts';

const tdb = await createTestDb();

if (!tdb.ok) {
  test('日志端点（跳过：MariaDB 不可用）', (t) => {
    t.skip(`MariaDB 不可用：${tdb.reason ?? '未知'}。启动 mariadbd 后重跑。`);
  });
} else {
  const { migrate } = await import('../src/store/migrate.ts');
  const { closePool, execute } = await import('../src/store/mysql.ts');
  const { putBase, appendSegment } = await import('../src/store/logbody.ts');
  const { findOrCreateSession } = await import('../src/store/session.ts');
  const { createHttpServer } = await import('../src/server/index.ts');

  await migrate();

  let server: Server;
  let origin = '';

  test.before(async () => {
    server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('无法取得监听端口');
    origin = `http://127.0.0.1:${addr.port}`;
  });

  test.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePool();
    await tdb.dispose();
  });

  async function reset(): Promise<void> {
    await execute('DELETE FROM log_bodies');
    await execute('DELETE FROM messages');
    await execute('DELETE FROM sessions');
  }

  async function getDocs(id: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await fetch(`${origin}/v1/log/${encodeURIComponent(id)}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  interface DocDto {
    name: string;
    lines: number;
    bytes: number;
    content: string;
    truncated: boolean;
  }

  test('ID 形态非法时返回 400', async () => {
    for (const bad of ['badid', '!!', 'abcdefgh']) {
      const r = await getDocs(bad);
      assert.equal(r.status, 400, `「${bad}」应被拒`);
    }
  });

  test('会话不存在时返回 404', async () => {
    await reset();
    const r = await getDocs('snotexist12345');
    assert.equal(r.status, 404);
  });

  test('返回主日志与行数', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600, 'o1', 'native');
    await putBase(s.id, { content: 'line1\nline2\nline3' });

    const r = await getDocs(s.id);
    assert.equal(r.status, 200);
    const docs = r.body['docs'] as DocDto[];
    assert.equal(docs[0]?.lines, 3);
    assert.equal(docs[0]?.content, 'line1\nline2\nline3');
  });

  test('追加段合并进正文，并报告 appended 数量', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600, 'o1', 'native');
    await putBase(s.id, { content: 'MAIN' });
    await appendSegment(s.id, { content: 'A1', source: 'crash.txt' });
    await appendSegment(s.id, { content: 'A2' });

    const r = await getDocs(s.id);
    const body = (r.body['docs'] as DocDto[])[0]!;

    assert.equal(r.body['appended'], 2);
    assert.ok(body.content.startsWith('MAIN'), '主日志必须在前');
    assert.ok(body.content.includes('===== crash.txt ====='));
    assert.ok(body.content.includes('===== 追加 2 ====='));
  });

  test('超过 2MB 的正文被截断并标记 truncated', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600, 'o1', 'native');
    const big = 'x'.repeat(2 * 1024 * 1024 + 100);
    await putBase(s.id, { content: big });

    const r = await getDocs(s.id);
    const doc = (r.body['docs'] as DocDto[])[0]!;
    assert.equal(doc.truncated, true);
    assert.equal(doc.content.length, 2 * 1024 * 1024);
    assert.equal(doc.bytes, big.length, 'bytes 报原始大小');
  });

  test('成功结果被缓存（二次请求不再查库）', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600, 'o1', 'native');
    await putBase(s.id, { content: 'CACHED' });

    const first = await getDocs(s.id);
    // 改库后仍应命中缓存（证明没再查）
    await putBase(s.id, { content: 'CHANGED' });
    const second = await getDocs(s.id);

    assert.equal(
      (second.body['docs'] as DocDto[])[0]?.content,
      (first.body['docs'] as DocDto[])[0]?.content,
      '缓存窗口内应返回同一份内容',
    );
  });

  test('refresh=1 跳进缓存读到最新内容', async () => {
    await reset();
    const s = await findOrCreateSession(null, 3600, 'o1', 'native');
    await putBase(s.id, { content: 'OLD' });
    await getDocs(s.id);

    await putBase(s.id, { content: 'NEW' });
    const res = await fetch(`${origin}/v1/log/${encodeURIComponent(s.id)}?refresh=1`);
    const body = (await res.json()) as { docs: DocDto[] };
    assert.equal(body.docs[0]?.content, 'NEW');
  });
}
