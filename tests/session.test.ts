/**
 * 会话存储测试。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendMessage,
  cleanupExpired,
  closeStore,
  countRounds,
  findOrCreateSession,
  getHistory,
  getSession,
  initStore,
} from '../src/store/session.ts';

const testDir = mkdtempSync(join(tmpdir(), 'lograg-session-'));
let dbCounter = 0;

function freshStore(): void {
  closeStore();
  initStore(join(testDir, `s${dbCounter++}.db`));
}

test.beforeEach(() => {
  freshStore();
});

test.after(() => {
  closeStore();
  rmSync(testDir, { recursive: true, force: true });
});

test('创建会话', () => {
  const s = findOrCreateSession(null, 3600);
  assert.ok(s.id.startsWith('s'));
  assert.equal(s.logId, null);
  assert.ok(s.expiresAt > s.createdAt);
});

test('携带 logId：同一主体复用会话（不重复创建）', () => {
  const a = findOrCreateSession('2usuLih', 3600, 'fp:alice');
  const b = findOrCreateSession('2usuLih', 3600, 'fp:alice');
  assert.equal(a.id, b.id, '同一主体在同一日志下应复用会话');
});

test('同一日志、不同主体不复用会话（隐私：日志 ID 是公开的）', () => {
  const alice = findOrCreateSession('3pubLic', 3600, 'fp:alice');
  const bob = findOrCreateSession('3pubLic', 3600, 'fp:bob');
  assert.notEqual(alice.id, bob.id, '不同访客不得进入同一个会话');

  // 各自的追问不会串到对方会话
  appendMessage(alice.id, 'user', 'alice 的问题');
  appendMessage(bob.id, 'user', 'bob 的问题');
  assert.equal(getHistory(alice.id).length, 1);
  assert.equal(getHistory(alice.id)[0]?.content, 'alice 的问题');
  assert.equal(getHistory(bob.id)[0]?.content, 'bob 的问题');
});

test('没有主体标识时不按 logId 复用（宁可多建，不把两人拼一起）', () => {
  const a = findOrCreateSession('4noOwne', 3600);
  const b = findOrCreateSession('4noOwne', 3600);
  assert.notEqual(a.id, b.id);
  assert.equal(a.owner, null);
});

test('不同 logId 建不同会话', () => {
  const a = findOrCreateSession('aaa1111', 3600);
  const b = findOrCreateSession('bbb2222', 3600);
  assert.notEqual(a.id, b.id);
});

test('无 logId 时每次都建新会话', () => {
  const a = findOrCreateSession(null, 3600);
  const b = findOrCreateSession(null, 3600);
  assert.notEqual(a.id, b.id);
});

test('取会话：过期后返回 null', () => {
  const s = findOrCreateSession(null, -1); // 已过期
  assert.equal(getSession(s.id), null);
});

test('消息追加与历史（时间正序）', () => {
  const s = findOrCreateSession(null, 3600);
  appendMessage(s.id, 'user', '第一条');
  appendMessage(s.id, 'assistant', '第一条回复', '思维链A');
  appendMessage(s.id, 'user', '第二条');

  const history = getHistory(s.id);
  assert.equal(history.length, 3);
  assert.equal(history[0]?.role, 'user');
  assert.equal(history[0]?.content, '第一条');
  assert.equal(history[1]?.role, 'assistant');
  assert.equal(history[1]?.reasoning, '思维链A');
  assert.equal(history[2]?.content, '第二条');
});

test('自评摘要随消息持久化并可回放', () => {
  const s = findOrCreateSession(null, 3600);
  const score = {
    overall: 92,
    deliverable: true,
    dimensions: { grounding: 79, verification: 100, actionability: 100, economy: 100 },
    deductions: ['6 条断言没有可核实的标识'],
    missingAnchors: ['libSDL3.so'],
  };
  appendMessage(s.id, 'user', '问题');
  appendMessage(s.id, 'assistant', '回答', '思维链', score);

  const history = getHistory(s.id);
  assert.equal(history[1]?.score?.overall, 92);
  assert.equal(history[1]?.score?.deliverable, true);
  assert.deepEqual(history[1]?.score?.missingAnchors, ['libSDL3.so']);
  // 用户消息不应带评分
  assert.equal(history[0]?.score, null);
});

test('损坏的自评 JSON 按 null 处理，不影响其余历史', async () => {
  const s = findOrCreateSession(null, 3600);
  appendMessage(s.id, 'assistant', '回答');
  // 直接写入坏数据（模拟旧版本或外部写入）
  const { getDb } = await import('../src/store/db.ts');
  getDb().prepare("UPDATE messages SET score = '{bad json' WHERE session_id = ?").run(s.id);

  const history = getHistory(s.id);
  assert.equal(history.length, 1);
  assert.equal(history[0]?.score, null);
});

test('历史条数上限（控制 token 消耗）', () => {
  const s = findOrCreateSession(null, 3600);
  for (let i = 0; i < 30; i++) {
    appendMessage(s.id, 'user', `消息${i}`);
  }
  const history = getHistory(s.id, 5);
  assert.equal(history.length, 5);
  // 应取**最近**的 5 条
  assert.equal(history[4]?.content, '消息29');
});

test('轮次计数只统计用户消息', () => {
  const s = findOrCreateSession(null, 3600);
  appendMessage(s.id, 'user', 'a');
  appendMessage(s.id, 'assistant', 'b');
  appendMessage(s.id, 'user', 'c');
  assert.equal(countRounds(s.id), 2);
});

test('清理过期会话（级联删除消息）', () => {
  const expired = findOrCreateSession(null, -1);
  const alive = findOrCreateSession(null, 3600);
  appendMessage(expired.id, 'user', 'x');

  const deleted = cleanupExpired();
  assert.ok(deleted >= 1);
  assert.equal(getSession(expired.id), null);
  assert.notEqual(getSession(alive.id), null);
  assert.equal(getHistory(expired.id).length, 0, '消息应被级联删除');
});

test('会话更新时间为最新消息时间', () => {
  const s = findOrCreateSession(null, 3600);
  appendMessage(s.id, 'user', 'x');
  const after = getSession(s.id);
  assert.ok(after !== null);
  assert.ok(after.updatedAt >= s.updatedAt);
});
