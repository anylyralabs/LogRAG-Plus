/**
 * 版本识别与「未配置即跳过」的回归测试。
 *
 * 这里只测**纯逻辑**（不加载 .so、不需要 mappings）：版本识别错了会导致
 * 用错映射表，反混淆会把类名改成另一个版本的名字——比不改更糟，所以
 * 各种启动器写法都要钉住。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deobfuscate, detectVersion } from '../src/agent/deobfuscate.ts';

test('原版 / Fabric 游戏日志：Loading Minecraft 1.21.11', () => {
  assert.equal(
    detectVersion('[12:00:00] [main/INFO]: Loading Minecraft 1.21.11 with Fabric Loader 0.15.0'),
    '1.21.11',
  );
});

test('崩溃报告：Minecraft Version: 1.20.1', () => {
  assert.equal(detectVersion('# Minecraft Version: 1.20.1\n# Minecraft Version ID: 1.20.1'), '1.20.1');
});

test('FCL / Pojav 启动器：从 classpath 的 intermediary 目录识别', () => {
  const log = [
    'Minecraft argument: --version',
    'Minecraft argument: 换形者诅咒',
    'Java argument: /storage/emulated/0/FCL/.minecraft/libraries/net/fabricmc/intermediary/1.20.1/intermediary-1.20.1.jar',
  ].join('\n');
  assert.equal(detectVersion(log), '1.20.1');
});

test('Forge 启动参数：--fml.mcVersion', () => {
  assert.equal(detectVersion('Java argument: --fml.mcVersion 1.20.1'), '1.20.1');
});

test('Forge maven 坐标：forge:1.20.1-47.4.23', () => {
  assert.equal(
    detectVersion('classpath: net.minecraftforge:forge:1.20.1-47.4.23:universal'),
    '1.20.1',
  );
});

test('原版启动器目录：versions/1.20.1/1.20.1.jar', () => {
  assert.equal(
    detectVersion('/home/x/.minecraft/versions/1.20.1/1.20.1.jar'),
    '1.20.1',
  );
});

test('实例名不是版本号：--version 换形者诅咒 不应命中', () => {
  const log = ['Minecraft argument: --version', 'Minecraft argument: 换形者诅咒'].join('\n');
  assert.equal(detectVersion(log), null);
});

test('完全无线索时返回 null（不猜）', () => {
  assert.equal(detectVersion('[main/INFO]: 启动失败'), null);
});

test('未配置 SpinYarn 时原样返回、且不报错（fail-open，不是失败）', () => {
  // 测试进程不读 .env，SPINYARN_SO 为空 → 走「未启用」分支
  const text = '[main/ERROR]: net.minecraft.class_310.method_1551';
  const r = deobfuscate(text);
  assert.equal(r.text, text);
  assert.equal(r.changed, false);
  assert.equal(r.error, undefined, '未配置是「没开启」，不该塞一条错误给调用方');
});
