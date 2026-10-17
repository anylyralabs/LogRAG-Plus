/**
 * LogShare ID 编解码测试。
 *
 * 测试向量来自 PHP `App\Id` 的实际输出（见 LogShare 仓库验证命令），
 * 确保跨语言实现逐位一致——不一致会导致 Node 读错日志或误判存储后端。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ID_CHARACTERS,
  ID_FULL_LENGTH,
  ID_RAW_LENGTH,
  decodeLogId,
  isMariaDbLogId,
  isValidLogId,
} from '../src/logshare/id.ts';

/** PHP 侧生成的权威向量：[fullId, storageId, rawId] */
const PHP_VECTORS: Array<[string, string, string]> = [
  ['Habcdef', 's', 'abcdef'],
  ['kABC123', 's', 'ABC123'],
  ['txyz789', 's', 'xyz789'],
  ['p000aaa', 's', '000aaa'],
  ['uabcdef', 'f', 'abcdef'],
  ['8ABC123', 'f', 'ABC123'],
  ['gxyz789', 'f', 'xyz789'],
  ['c000aaa', 'f', '000aaa'],
];

test('ID 字符集与长度契约与 PHP 一致', () => {
  assert.equal(
    ID_CHARACTERS,
    'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
  );
  assert.equal(ID_CHARACTERS.length, 62);
  assert.equal(ID_RAW_LENGTH, 6);
  assert.equal(ID_FULL_LENGTH, 7);
});

test('解码与 PHP App\\Id 输出逐位一致', () => {
  for (const [full, storageId, rawId] of PHP_VECTORS) {
    const decoded = decodeLogId(full);
    assert.ok(decoded, `${full} 应可解码`);
    assert.equal(decoded.storageId, storageId, `${full} 的存储后端应为 ${storageId}`);
    assert.equal(decoded.rawId, rawId, `${full} 的 rawId 应为 ${rawId}`);
    assert.equal(decoded.fullId, full);
  }
});

test('存储后端判定：s 走 MariaDB，f 走文件系统', () => {
  assert.equal(isMariaDbLogId('Habcdef'), true);
  assert.equal(isMariaDbLogId('kABC123'), true);
  assert.equal(isMariaDbLogId('uabcdef'), false);
  assert.equal(isMariaDbLogId('8ABC123'), false);
});

test('非法 ID 一律拒绝（面向公网输入，不可信任）', () => {
  const invalid = [
    '',
    'abc', // 过短
    'abcdefgh', // 过长
    'Habcde!', // 非法字符
    'Habcde-', // 非法字符
    '中文中文中文', // 非 ASCII
    '../../etc/passwd', // 路径遍历
    "H' OR '1'='1", // SQL 注入尝试
  ];
  for (const id of invalid) {
    assert.equal(isValidLogId(id), false, `${id} 应被判为非法`);
    assert.equal(decodeLogId(id), null, `${id} 应解码失败`);
    assert.equal(isMariaDbLogId(id), false, `${id} 不应被当作 MariaDB ID`);
  }
});

test('真实样本 ID 可解码（来自实测上传）', () => {
  // 实测中实际上传返回的 ID
  for (const id of ['2usuLih', 'dSHTM5E', 'E9VxukZ', '4oZbLDQ']) {
    const decoded = decodeLogId(id);
    assert.ok(decoded, `${id} 应可解码`);
    assert.equal(decoded.rawId.length, ID_RAW_LENGTH);
    assert.ok(ID_CHARACTERS.includes(decoded.storageId));
  }
});
