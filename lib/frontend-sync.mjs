import fs from 'node:fs/promises';
import path from 'node:path';

const FILES = ['index.js', 'style.css', 'manifest.json'];

export async function syncFrontend(source) {
    if (path.basename(path.dirname(source)) !== 'plugins') throw new Error('服务端组件没有放在酒馆 plugins 目录中。');
    const target = path.join(source, '../../public/scripts/extensions/third-party/workbuddy-local');
    let existing;
    try { existing = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && existing.display_name !== 'WorkBuddy 本机连接') throw new Error('目标目录属于其他扩展，无法同步。');
    if (!existing) {
        let entries;
        try { entries = await fs.readdir(target); }
        catch (error) { if (error.code !== 'ENOENT') throw error; entries = []; }
        if (entries.length) throw new Error('目标目录已有未识别的文件，无法同步。');
    }
    await fs.mkdir(target, { recursive: true });
    for (const name of FILES) {
        const content = await fs.readFile(path.join(source, name));
        let installed;
        try { installed = await fs.readFile(path.join(target, name)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!installed?.equals(content)) await fs.writeFile(path.join(target, name), content);
    }
}
