import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Bridge, normalizeChat } from '../lib/bridge.mjs';
import { Provider, validateLoginURL } from '../lib/provider.mjs';
import { chunks, collect } from '../lib/sse.mjs';

const auth = () => ({ edition: 'cn', auth: { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Math.floor(Date.now() / 1000) + 3600 }, account: { uid: 'test-user', nickname: '测试用户' } });
const stream = () => ': heartbeat\r\n\r\ndata: {"id":"test","choices":[{"index":0,"delta":{"content":"你好","reasoning_content":"思考"},"finish_reason":""}]}\r\n\r\ndata: {"choices":[{"index":0,"delta":{"content":"世界"},"finish_reason":"stop"}],"usage":{"total_tokens":8}}\n\ndata: [DONE]\n\n';
const streamBody = value => new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(value);
    for (let i = 0; i < bytes.length; i += 3) controller.enqueue(bytes.slice(i, i + 3));
    controller.close();
} });

function mockProvider() {
    let refreshes = 0;
    return {
        get refreshes() { return refreshes; },
        loginStart: async () => ({ state: 'synthetic-state', authUrl: 'https://copilot.tencent.com/login?state=synthetic' }),
        loginPoll: async () => auth(),
        refresh: async stored => { refreshes++; await new Promise(resolve => setTimeout(resolve, 20)); return { ...stored, auth: { ...stored.auth, expiresAt: Math.floor(Date.now() / 1000) + 3600 } }; },
        models: async stored => [{ id: stored.account.uid, name: '测试模型', credits: 'x0.00' }],
        chat: async (_stored, body) => {
            assert.equal(body.stream, true);
            return new Response(streamBody(stream()), { headers: { 'Content-Type': 'text/event-stream' } });
        },
    };
}

async function fixture(t, provider = mockProvider()) {
    const temporaryRoot = path.resolve(process.env.WORKBUDDY_TEST_TMP || os.tmpdir());
    await fs.mkdir(temporaryRoot, { recursive: true });
    const directory = await fs.mkdtemp(path.join(temporaryRoot, 'workbuddy-plugin-test-'));
    const bridge = new Bridge({ provider });
    await bridge.start();
    t.after(async () => {
        await bridge.close();
        if (path.dirname(directory) !== temporaryRoot) throw new Error('测试目录越界');
        await fs.rm(directory, { recursive: true, force: true });
    });
    const user = await bridge.user(path.join(directory, 'a'));
    return { directory, bridge, user, provider };
}

function request(bridge, user, route, options = {}) {
    return fetch(`${bridge.baseURL}${route}`, {
        ...options, headers: { Authorization: `Bearer ${user.key}`, 'Content-Type': 'application/json', ...options.headers },
    });
}

test('登录持久保存，状态不暴露腾讯凭据，取消登录与退出生效', async t => {
    const { bridge, user } = await fixture(t);
    assert.equal(bridge.status(user).loggedIn, false);
    await bridge.loginStart(user);
    await bridge.loginPoll(user);
    const status = JSON.stringify(bridge.status(user));
    assert.ok(!status.includes('synthetic-access') && !status.includes('synthetic-refresh'));
    assert.equal((JSON.parse(await fs.readFile(user.authFile, 'utf8'))).account.uid, 'test-user');
    await bridge.logout(user);
    assert.equal(user.stored, null);
    await assert.rejects(fs.stat(user.authFile), { code: 'ENOENT' });
    await assert.rejects(bridge.loginPoll(user), { status: 410 });
});

test('用户隔离、并发加载、密钥持久和匿名拒绝', async t => {
    const { bridge, user, directory } = await fixture(t);
    const other = await bridge.user(path.join(directory, 'b'));
    const [again, again2] = await Promise.all([bridge.user(path.join(directory, 'a')), bridge.user(path.join(directory, 'a'))]);
    assert.equal(again, again2); assert.equal(again, user); assert.notEqual(user.key, other.key);
    user.stored = auth(); other.stored = auth(); other.stored.account.uid = 'other';
    const response = await request(bridge, other, '/models');
    assert.equal((await response.json()).data[0].id, 'other');
    const saved = JSON.parse(await fs.readFile(path.join(user.directory, 'bridge-key.json'), 'utf8'));
    assert.equal(saved.key, user.key);
    await assert.rejects(bridge.user(undefined), { status: 401 });
});

test('无密钥、浏览器 Origin、Sec-Fetch 和错误 Host 都不能调用', async t => {
    const { bridge, user } = await fixture(t);
    assert.equal((await fetch(`${bridge.baseURL}/models`)).status, 401);
    assert.equal((await request(bridge, user, '/models', { headers: { Origin: 'https://evil.example' } })).status, 403);
    assert.equal((await request(bridge, user, '/models', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 403);
    const hostStatus = await new Promise((resolve, reject) => {
        const request = http.get(`${bridge.baseURL}/models`, { headers: { Host: 'evil.example', Authorization: `Bearer ${user.key}` } }, response => { response.resume(); resolve(response.statusCode); });
        request.on('error', reject);
    });
    assert.equal(hostStatus, 403);
});

test('SSE 处理分段中文、CRLF、空 finish_reason、usage 和非流式聚合', async () => {
    const received = [];
    for await (const chunk of chunks(streamBody(stream()))) received.push(chunk);
    assert.equal(received[0].choices[0].finish_reason, null);
    const response = await collect(streamBody(stream()), 'test-model');
    assert.equal(response.choices[0].message.content, '你好世界');
    assert.equal(response.choices[0].message.reasoning_content, '思考');
    assert.equal(response.choices[0].finish_reason, 'stop');
    assert.equal(response.usage.total_tokens, 8);
});

test('HTTP 流式、非流式接口可用', async t => {
    const { bridge, user } = await fixture(t); user.stored = auth();
    const payload = { model: 'hy3', messages: [{ role: 'user', content: '测试' }], max_tokens: 128 };
    const response = await request(bridge, user, '/chat/completions', { method: 'POST', body: JSON.stringify(payload) });
    assert.equal(response.status, 200); assert.equal((await response.json()).choices[0].message.content, '你好世界');
    const live = await request(bridge, user, '/chat/completions', { method: 'POST', body: JSON.stringify({ ...payload, stream: true }) });
    const text = await live.text(); assert.ok(text.endsWith('data: [DONE]\n\n')); assert.ok(text.includes('你好'));
});

test('上游错误和提前断流不会伪装成成功，错误体不会泄露凭据', async t => {
    const provider = mockProvider();
    const { bridge, user } = await fixture(t, provider); user.stored = auth();
    provider.chat = async () => new Response('synthetic-access private-prompt', { status: 429 });
    const payload = JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'private-prompt' }] });
    const response = await request(bridge, user, '/chat/completions', { method: 'POST', body: payload });
    assert.equal(response.status, 429); assert.ok(!(await response.text()).includes('private-prompt'));
    await assert.rejects(collect(streamBody('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'), 'hy3'), { status: 502 });
    await assert.rejects(collect(streamBody('data: {"error":{"message":"synthetic-access"}}\n\n'), 'hy3'), error => !error.message.includes('synthetic-access'));
});

test('多个请求共享一次凭据续期', async t => {
    const { bridge, user, provider } = await fixture(t); user.stored = auth(); user.stored.auth.expiresAt = 0;
    await Promise.all([bridge.credentials(user), bridge.credentials(user), bridge.credentials(user)]);
    assert.equal(provider.refreshes, 1);
});

test('请求大小、格式、候选数量、角色校验；保留原始系统提示', async t => {
    const { bridge, user } = await fixture(t); user.stored = auth();
    assert.equal((await request(bridge, user, '/chat/completions', { method: 'POST', body: '{' })).status, 400);
    const large = JSON.stringify({ model: 'hy3', messages: [{ role: 'user', content: 'x'.repeat(2 * 1024 * 1024) }] });
    assert.equal((await request(bridge, user, '/chat/completions', { method: 'POST', body: large })).status, 413);
    const system = '这是用户自己的角色设定，不应改写。';
    const normalized = normalizeChat({ model: 'hy3', messages: [{ role: 'developer', content: system }, { role: 'user', content: '你好' }] });
    assert.equal(normalized.messages[0].content, system); assert.equal(normalized.messages[0].role, 'system');
    assert.throws(() => normalizeChat({ model: 'hy3', n: 2, messages: [{ role: 'user', content: 'hi' }] }), { status: 400 });
});

test('只允许官方 HTTPS 登录域名；授权状态确实绑定到腾讯服务', async () => {
    assert.equal(validateLoginURL('https://copilot.tencent.com/login'), 'https://copilot.tencent.com/login');
    for (const value of ['http://copilot.tencent.com/login', 'https://copilot.tencent.com.evil.example/', 'https://evil.example/', 'https://a:b@copilot.tencent.com/']) assert.throws(() => validateLoginURL(value));
    const provider = new Provider(async (url, options) => {
        assert.equal(url, 'https://copilot.tencent.com/v2/plugin/auth/state?platform=VSCode');
        assert.equal(options.redirect, 'error');
        return Response.json({ code: 0, data: { state: 'synthetic', authUrl: 'https://copilot.tencent.com/login' } });
    });
    assert.equal((await provider.loginStart()).state, 'synthetic');
});

test('关闭和客户端取消会终止上游生成', async t => {
    const provider = mockProvider();
    let aborted;
    const signalEvent = new Promise(resolve => { aborted = resolve; });
    provider.chat = async (_stored, _body, signal) => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"开始"}}]}\n\n'));
        signal.addEventListener('abort', () => { aborted(); controller.error(new Error('cancelled')); }, { once: true });
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
    const { bridge, user } = await fixture(t, provider); user.stored = auth();
    const controller = new AbortController();
    const response = await request(bridge, user, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'hy3', stream: true, messages: [{ role: 'user', content: '测试' }] }), signal: controller.signal });
    const reader = response.body.getReader(); await reader.read(); controller.abort();
    await Promise.race([signalEvent, new Promise((_, reject) => setTimeout(() => reject(new Error('上游未取消')), 2000))]);
});
