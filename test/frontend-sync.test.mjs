import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncFrontend } from '../lib/frontend-sync.mjs';

async function fixture(t) {
    const temporaryRoot = path.resolve(process.env.WORKBUDDY_TEST_TMP || os.tmpdir());
    await fs.mkdir(temporaryRoot, { recursive: true });
    const root = await fs.mkdtemp(path.join(temporaryRoot, 'workbuddy-sync-test-'));
    t.after(async () => { if (path.dirname(root) !== temporaryRoot) throw new Error('测试目录越界'); await fs.rm(root, { recursive: true, force: true }); });
    const source = path.join(root, 'plugins/workbuddy');
    const target = path.join(root, 'public/scripts/extensions/third-party/workbuddy-local');
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(source, 'manifest.json'), JSON.stringify({ display_name: 'WorkBuddy 本机连接', version: 'new-version' }));
    await fs.writeFile(path.join(source, 'index.js'), 'new frontend');
    await fs.writeFile(path.join(source, 'style.css'), 'new style');
    await fs.writeFile(path.join(source, 'server-private.json'), 'synthetic-private-data');
    return { source, target };
}

test('服务端升级后同步旧界面，但不把服务端文件复制到网页目录', async t => {
    const { source, target } = await fixture(t);
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify({ display_name: 'WorkBuddy 本机连接', version: 'old-version' }));
    await fs.writeFile(path.join(target, 'index.js'), 'old frontend');
    await syncFrontend(source);
    assert.equal(await fs.readFile(path.join(target, 'index.js'), 'utf8'), 'new frontend');
    assert.equal(JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8')).version, 'new-version');
    assert.deepEqual((await fs.readdir(target)).sort(), ['index.js', 'manifest.json', 'style.css']);
});

test('同步不能覆盖其他扩展或未识别的现有文件', async t => {
    const { source, target } = await fixture(t);
    await fs.writeFile(path.join(target, 'index.js'), 'keep this unrelated file');
    await assert.rejects(syncFrontend(source));
    assert.equal(await fs.readFile(path.join(target, 'index.js'), 'utf8'), 'keep this unrelated file');
    await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify({ display_name: 'Another extension' }));
    await assert.rejects(syncFrontend(source));
    assert.equal(await fs.readFile(path.join(target, 'index.js'), 'utf8'), 'keep this unrelated file');
});
