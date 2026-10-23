/**
 * 日志正文与追加段测试。
 *
 * ## 守的是什么
 *
 * 「追加日志」是本次架构改革的核心能力，而它最容易出的问题是**合并顺序与
 * 边界**：追加段的 `seq` 冲突、合并时漏掉主日志、分隔标记被界面误解析。
 * 这些都不会报错，只会让模型读到一份错乱的日志。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb } from './helpers/testdb.ts';

const tdb = await createTestDb();

if (!tdb.ok) {
  test('日志正文（跳过：MariaDB 不可用）', (t) => {
    t.skip(`MariaDB 不可用：${tdb.reason ?? '未知'}。启动 mariadbd 后重跑。`);
  });
} else {
  const { migrate } = await import('../src/store/migrate.ts');
  const { closePool, execute } = await import('../src/store/mysql.ts');
  const {
    putBase,
    appendSegment,
    listSegments,
    listAppends,
    getBase,
    mergeSegments,
    countSegments,
    totalBytes,
    deleteBodies,
    measure,
  } = await import('../src/store/logbody.ts');

  await migrate();

  test.after(async () => {
    await closePool();
    await tdb.dispose();
  });

  async function reset(): Promise<void> {
    await execute('DELETE FROM log_bodies');
  }

  test('写入主日志并读回', async () => {
    await reset();
    const body = '[12:00:00] [main/INFO]: Loading\n[12:00:05] [main/ERROR]: boom';
    await putBase('s1', { content: body, source: 'latest.log' });

    const base = await getBase('s1');
    assert.equal(base?.content, body);
    assert.equal(base?.seq, 0);
    assert.equal(base?.source, 'latest.log');
    assert.equal(base?.lineCount, 2);
  });

  test('追加段按 seq 递增，不覆盖主日志', async () => {
    await reset();
    await putBase('s2', { content: 'BASE' });

    const a1 = await appendSegment('s2', { content: 'APPEND-1' });
    const a2 = await appendSegment('s2', { content: 'APPEND-2' });

    assert.equal(a1.seq, 1);
    assert.equal(a2.seq, 2);
    assert.equal(a2.total, 3);

    // 主日志必须原样还在
    assert.equal((await getBase('s2'))?.content, 'BASE');
    assert.deepEqual(
      (await listAppends('s2')).map((s) => s.content),
      ['APPEND-1', 'APPEND-2'],
    );
  });

  test('合并：主日志在前，追加段在后，带分隔标记', async () => {
    await reset();
    await putBase('s3', { content: 'BASE' });
    await appendSegment('s3', { content: 'CRASH', source: 'crash-report.txt' });

    const merged = mergeSegments(
      (await getBase('s3'))?.content ?? null,
      await listAppends('s3'),
    );

    assert.ok(merged.startsWith('BASE'), '主日志必须在前');
    assert.ok(merged.includes('===== crash-report.txt ====='), '应带来源名');
    assert.ok(merged.indexOf('BASE') < merged.indexOf('CRASH'), '追加段在主日志之后');
  });

  test('合并：追加段无来源名时用「追加 N」作标记', async () => {
    await reset();
    await putBase('s4', { content: 'BASE' });
    await appendSegment('s4', { content: 'MORE' });

    const merged = mergeSegments('BASE', await listAppends('s4'));
    assert.ok(merged.includes('===== 追加 1 ====='));
  });

  test('LogShare 会话：本库没有主日志时，追加从 1 开始', async () => {
    await reset();
    // 不写 putBase（基础正文在 LogShare 那边）
    const a = await appendSegment('s5', { content: 'ONLY-APPEND' });
    assert.equal(a.seq, 1);
    assert.equal(await getBase('s5'), null);
    assert.equal(await countSegments('s5'), 1);
  });

  test('LogShare 会话：合并时只有追加段', async () => {
    await reset();
    await appendSegment('s6', { content: 'A1' });
    const merged = mergeSegments(null, await listAppends('s6'));
    assert.ok(merged.includes('A1'));
  });

  test('files 附件能往返', async () => {
    await reset();
    const files = [{ name: 'crash-report.txt', data: 'crash body' }];
    await putBase('s7', { content: 'BODY', files });

    const base = await getBase('s7');
    assert.equal(base?.files?.[0]?.name, 'crash-report.txt');
    assert.equal(base?.files?.[0]?.data, 'crash body');
  });

  test('重复 putBase 覆盖主日志但保留追加段', async () => {
    await reset();
    await putBase('s8', { content: 'OLD' });
    await appendSegment('s8', { content: 'KEEP' });
    await putBase('s8', { content: 'NEW' });

    assert.equal((await getBase('s8'))?.content, 'NEW');
    assert.equal((await listAppends('s8'))[0]?.content, 'KEEP', '追加段不该被覆盖');
  });

  test('字节与行数统计', async () => {
    assert.deepEqual(measure(''), { bytes: 0, lineCount: 0 });
    assert.deepEqual(measure('a'), { bytes: 1, lineCount: 1 });
    assert.deepEqual(measure('a\nb'), { bytes: 3, lineCount: 2 });
    // 中文按 UTF-8 计字节
    assert.equal(measure('中文').bytes, 6);
  });

  test('总字节累加所有段', async () => {
    await reset();
    await putBase('s9', { content: '12345' });
    await appendSegment('s9', { content: '678' });
    assert.equal(await totalBytes('s9'), 8);
  });

  test('删除正文清空全部段', async () => {
    await reset();
    await putBase('s10', { content: 'B' });
    await appendSegment('s10', { content: 'A' });
    const n = await deleteBodies('s10');
    assert.equal(n, 2);
    assert.equal(await countSegments('s10'), 0);
  });

  test('全部段按 seq 升序返回', async () => {
    await reset();
    await putBase('s11', { content: 'S0' });
    await appendSegment('s11', { content: 'S1' });
    await appendSegment('s11', { content: 'S2' });
    const segs = await listSegments('s11');
    assert.deepEqual(segs.map((s) => s.seq), [0, 1, 2]);
  });
}
