import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

// Execute the real frontend entry point with Tavern dependencies and DOM controls mocked.
// This checks asynchronous UI behavior without contacting a service or using a real account.
const source = (await fs.readFile(new URL('../index.js', import.meta.url), 'utf8')).replace(/^import .*;\r?\n/gm, '');
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function frontend({ model = 'new-model', routeOverrides = {} } = {}) {
    const controls = Object.fromEntries(['main_api', 'chat_completion_source', 'custom_api_url_text', 'custom_model_id'].map(id => [id, { value: '' }]));
    Object.assign(controls.main_api, { value: 'openai' });
    controls.chat_completion_source.value = 'custom';
    controls.custom_api_url_text.value = 'http://127.0.0.1:10000/v1';
    controls.custom_model_id.value = model;
    const extension_settings = { workbuddy_local: { baseURL: controls.custom_api_url_text.value, model: 'old-model' } };
    const oai_settings = { chat_completion_source: 'custom', custom_url: controls.custom_api_url_text.value, custom_model: model };
    const buttons = Object.fromEntries(['login', 'logout', 'models', 'connect'].map(action => [action, { dataset: { action }, disabled: false, addEventListener(_event, callback) { this.click = callback; } }]));
    const status = { textContent: '' }, link = { hidden: true }, timers = [];
    const select = { value: '', options: [], disabled: true,
        replaceChildren() { this.options = []; this.value = ''; },
        append(option) { this.options.push(option); if (this.options.length === 1) this.value = option.value; } };
    const panel = { querySelector(selector) {
        if (selector === '.wb-status') return status;
        if (selector === '.wb-login-link') return link;
        if (selector === 'select') return select;
        return buttons[selector.match(/data-action="([^"]+)"/)[1]];
    }, querySelectorAll() { return Object.values(buttons); } };
    const ready = [];
    let loggedIn = true;
    const calls = [];
    const $ = selector => {
        const id = selector.slice(1), node = controls[id];
        return { length: node ? 1 : 0, val(value) { if (value === undefined) return node?.value; if (node) node.value = value; return this; }, trigger(event) {
            if (node && event === 'input' && id === 'custom_api_url_text') oai_settings.custom_url = node.value;
            if (node && event === 'input' && id === 'custom_model_id') oai_settings.custom_model = node.value;
            if (node && event === 'change' && id === 'chat_completion_source') oai_settings.chat_completion_source = node.value;
            return this;
        } };
    };
    const context = vm.createContext({ $, jQuery: callback => { ready.push(callback()); },
        document: { createElement: type => type === 'div' ? panel : {}, querySelector: () => ({ append() {} }) },
        window: { open: () => ({ opener: {}, location: { replace() {} }, close() {} }) },
        extension_settings, oai_settings, getRequestHeaders: () => ({}), saveSettingsDebounced() {},
        SECRET_KEYS: { CUSTOM: 'api_key_custom' }, writeSecret: async () => 'fake-secret-id',
        URL, setTimeout: callback => { timers.push(callback); },
        fetch: async url => {
            const route = url.replace('/api/plugins/workbuddy', ''); calls.push(route);
            if (routeOverrides[route]) return Response.json(await routeOverrides[route]());
            if (route === '/status') return Response.json({ loggedIn, nickname: 'test' });
            if (route === '/models') return Response.json({ models: [{ id: 'old-model' }, { id: model }] });
            if (route === '/connection') return Response.json({ baseURL: 'http://127.0.0.1:20000/v1', key: 'synthetic' });
            if (route === '/logout') { loggedIn = false; return Response.json({ loggedIn }); }
            if (route === '/login/start') return Response.json({ authUrl: 'https://copilot.tencent.com/login' });
            if (route === '/login/poll') return Response.json({ pending: true });
            throw new Error(`Unexpected route ${route}`);
        },
    });
    vm.runInContext(source, context);
    return { ready: Promise.all(ready), controls, oai_settings, extension_settings, buttons, status, link, timers, calls };
}

test('重启恢复本机地址时保留用户后来选的模型', async () => {
    const ui = await frontend(); await ui.ready;
    assert.equal(ui.oai_settings.custom_url, 'http://127.0.0.1:20000/v1');
    assert.equal(ui.oai_settings.custom_model, 'new-model');
});

test('模型加载期间切换其他连接，晚返回的恢复请求不能覆盖新地址', async () => {
    const models = deferred();
    const ui = await frontend({ routeOverrides: { '/models': () => models.promise } }); await flush();
    ui.controls.custom_api_url_text.value = 'https://other.example/v1';
    ui.oai_settings.custom_url = 'https://other.example/v1';
    models.resolve({ models: [{ id: 'new-model' }] }); await ui.ready;
    assert.equal(ui.oai_settings.custom_url, 'https://other.example/v1');
});

test('获取本机地址期间切换其他连接，恢复请求也不能覆盖新地址', async () => {
    const connection = deferred();
    const ui = await frontend({ routeOverrides: { '/connection': () => connection.promise } }); await flush();
    ui.controls.custom_api_url_text.value = 'https://other.example/v1';
    ui.oai_settings.custom_url = 'https://other.example/v1';
    connection.resolve({ baseURL: 'http://127.0.0.1:20000/v1', key: 'synthetic' }); await ui.ready;
    assert.equal(ui.oai_settings.custom_url, 'https://other.example/v1');
});

test('取消后立即开始新登录，旧初始化结果不能结束新轮询', async () => {
    const oldLogin = deferred(); let attempts = 0;
    const ui = await frontend({ routeOverrides: { '/login/start': () => ++attempts === 1 ? oldLogin.promise : { authUrl: 'https://copilot.tencent.com/login' } } }); await ui.ready;
    ui.buttons.logout.click(); await flush();
    ui.buttons.login.click(); await flush();
    ui.buttons.logout.click(); await flush();
    ui.buttons.login.click(); await flush();
    const requestCount = ui.calls.filter(route => route === '/login/poll').length;
    oldLogin.resolve({ authUrl: 'https://copilot.tencent.com/login?state=obsolete' }); await flush();
    for (const callback of ui.timers.splice(0)) callback(); await flush();
    assert.ok(ui.calls.filter(route => route === '/login/poll').length > requestCount, '新的登录仍应继续轮询');
    assert.ok(!ui.link.href.includes('obsolete'), '旧链接不能替换新登录链接');
});

test('退出请求断网后仍能点击退出重试，不能误以为已退出', async () => {
    let attempts = 0;
    const ui = await frontend({ routeOverrides: { '/logout': () => { if (++attempts === 1) throw new Error('offline'); return { loggedIn: false }; }, '/status': () => ({ loggedIn: attempts < 2, nickname: 'test' }) } });
    await ui.ready;
    ui.buttons.logout.click(); await flush();
    assert.equal(ui.buttons.logout.disabled, false);
    assert.equal(ui.buttons.login.disabled, true);
    ui.buttons.logout.click(); await flush();
    assert.equal(ui.buttons.login.disabled, false);
    assert.equal(attempts, 2);
});
