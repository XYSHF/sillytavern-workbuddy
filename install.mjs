import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const source = path.dirname(fileURLToPath(import.meta.url));
const tavern = path.resolve(source, '../..');
const target = path.join(tavern, 'public/scripts/extensions/third-party/workbuddy-local');

async function install() {
    if (Number(process.versions.node.split('.')[0]) < 20) throw new Error('需要 Node.js 20 或更高版本。');
    if (path.basename(path.dirname(source)) !== 'plugins') throw new Error('请把本插件文件夹放在酒馆的 plugins 文件夹里，再运行安装。');
    const tavernPackage = JSON.parse(await fs.readFile(path.join(tavern, 'package.json'), 'utf8'));
    if (tavernPackage.name.toLowerCase() !== 'sillytavern') throw new Error('没有找到酒馆安装目录。');
    const configPath = path.join(tavern, 'config.yaml');
    const config = await fs.readFile(configPath, 'utf8');
    const pattern = /^(\s*)enableServerPlugins:\s*(true|false)[^\r\n]*$/m;
    if (!pattern.test(config)) throw new Error('配置中没有 enableServerPlugins，请确认酒馆版本。');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = `${configPath}.workbuddy-${timestamp}.bak`;
    let existing;
    try { existing = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing && existing.display_name !== 'WorkBuddy 本机连接') throw new Error('目标扩展目录已被其他扩展使用，请换一个目录。');
    await fs.copyFile(configPath, backup);
    await fs.mkdir(target, { recursive: true });
    for (const name of ['index.js', 'style.css', 'manifest.json']) await fs.copyFile(path.join(source, name), path.join(target, name));
    const next = config.replace(pattern, (_match, indent) => `${indent}enableServerPlugins: true`);
    await fs.writeFile(configPath, next);
    console.log('安装完成。请重启酒馆，在“扩展设置 → WorkBuddy 本机连接”中登录、选模型、接入。');
    console.log(`原配置已备份：${backup}`);
}

install().catch(error => { console.error(`安装失败：${error.message}`); process.exitCode = 1; });
