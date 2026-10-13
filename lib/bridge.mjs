import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Provider, BridgeError } from './provider.mjs';
import { chunks, collect } from './sse.mjs';

const LIMIT = 2 * 1024 * 1024;
const errorBody = error => ({ error: { message: error instanceof BridgeError ? error.message : '本机插件发生错误。', type: 'workbuddy_error' } });
const statusCode = error => error instanceof BridgeError ? error.status : 500;

async function writePrivate(filename, value) {
    const temporary = `${filename}.${randomBytes(6).toString('hex')}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    try { await fs.rename(temporary, filename); }
    finally { await fs.unlink(temporary).catch(() => {}); }
}

async function readJSON(filename) {
    try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function equal(a, b) {
    const left = Buffer.from(a), right = Buffer.from(b);
    return left.length === right.length && timingSafeEqual(left, right);
}

async function requestJSON(req) {
    const contentLength = Number(req.headers['content-length']);
    if (contentLength > LIMIT) throw new BridgeError(413, '请求内容超过 2 MB。');
    let length = 0;
    const buffers = [];
    for await (const buffer of req) {
        length += buffer.length;
        if (length > LIMIT) throw new BridgeError(413, '请求内容超过 2 MB。');
        buffers.push(buffer);
    }
    try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); }
    catch { throw new BridgeError(400, '请求必须是 JSON。'); }
}

export function normalizeChat(input) {
    if (!input || typeof input !== 'object' || !Array.isArray(input.messages) || !input.messages.length || typeof input.model !== 'string' || !input.model) {
        throw new BridgeError(400, '必须提供模型和对话消息。');
    }
    if (input.n != null && input.n !== 1) throw new BridgeError(400, '当前版本只支持一次生成一个回复。');
    const messages = input.messages.map(message => {
        if (!message || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw new BridgeError(400, '消息角色无效。');
        return { ...message, role: message.role === 'developer' ? 'system' : message.role };
    });
    if (messages[0].role !== 'system') messages.unshift({ role: 'system', content: 'You are a helpful assistant.' });
    const max = input.max_tokens ?? input.max_completion_tokens ?? 4096;
    if (!Number.isInteger(max) || max < 1 || max > 131072) throw new BridgeError(400, '回复长度必须在 1 到 131072 之间。');
    const result = { model: input.model, messages, max_tokens: max, stream: true };
    for (const key of ['temperature', 'top_p', 'stop', 'frequency_penalty', 'presence_penalty', 'seed', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'stream_options']) {
        if (input[key] != null) result[key] = input[key];
    }
    return result;
}

export class Bridge {
    constructor({ provider = new Provider() } = {}) {
        this.provider = provider;
        this.users = new Map();
        this.loading = new Map();
        this.controllers = new Set();
        this.server = http.createServer((req, res) => void this.handle(req, res));
        this.server.requestTimeout = 30_000;
        this.server.headersTimeout = 15_000;
    }

    async start() {
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
        });
        this.baseURL = `http://127.0.0.1:${this.server.address().port}/v1`;
    }

    async close() {
        for (const controller of this.controllers) controller.abort();
        const closed = new Promise(resolve => this.server.close(resolve));
        this.server.closeAllConnections();
        await closed;
    }

    async user(root) {
        if (typeof root !== 'string' || !root) throw new BridgeError(401, '请先登录酒馆。');
        const resolved = path.resolve(root);
        if (!this.loading.has(resolved)) this.loading.set(resolved, this.loadUser(resolved));
        try { return await this.loading.get(resolved); }
        catch (error) { this.loading.delete(resolved); throw error; }
    }

    async loadUser(root) {
        const directory = path.join(root, '.workbuddy-plugin');
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const authFile = path.join(directory, 'auth.json');
        const keyFile = path.join(directory, 'bridge-key.json');
        let key = (await readJSON(keyFile))?.key;
        if (typeof key !== 'string' || !/^wb-local-[a-f0-9]{64}$/.test(key)) {
            key = `wb-local-${randomBytes(32).toString('hex')}`;
            await writePrivate(keyFile, { key });
        }
        const user = { directory, authFile, key, stored: await readJSON(authFile), pending: null, refresh: null, poll: null,
            generation: 0, loggingOut: null, controllers: new Set() };
        this.users.set(root, user);
        return user;
    }

    async credentials(user) {
        if (!user.stored?.auth?.accessToken) throw new BridgeError(401, '请在酒馆扩展里登录 WorkBuddy。');
        if ((user.stored.auth.expiresAt || 0) * 1000 > Date.now() + 120_000) return user.stored;
        if (!user.refresh) {
            const previous = user.stored;
            const generation = user.generation;
            user.refresh = (async () => {
                const next = await this.provider.refresh(previous);
                if (user.stored !== previous || user.generation !== generation) throw new BridgeError(401, '账号已退出，请重新连接。');
                await writePrivate(user.authFile, next);
                if (user.stored !== previous || user.generation !== generation) throw new BridgeError(401, '账号已退出，请重新连接。');
                user.stored = next;
                return next;
            })().finally(() => { user.refresh = null; });
        }
        return user.refresh;
    }

    status(user) { return { loggedIn: Boolean(user.stored), nickname: user.stored?.account?.nickname || '', baseURL: this.baseURL }; }

    async loginStart(user) {
        if (user.stored) throw new BridgeError(409, '已登录，切换账号请先退出。');
        if (user.loggingOut) throw new BridgeError(409, '正在退出，请稍后再登录。');
        const generation = ++user.generation;
        user.pending = null;
        const pending = await this.provider.loginStart();
        if (user.generation !== generation || user.loggingOut) throw new BridgeError(409, '登录已取消，请重试。');
        user.pending = { ...pending, expiresAt: Date.now() + 5 * 60_000 };
        return { authUrl: pending.authUrl };
    }

    async loginPoll(user) {
        if (!user.pending || user.pending.expiresAt < Date.now()) throw new BridgeError(410, '登录链接已过期，请重新点击登录。');
        if (!user.poll) {
            const pending = user.pending;
            const generation = user.generation;
            user.poll = (async () => {
                const stored = await this.provider.loginPoll(pending.state);
                if (user.pending !== pending || user.generation !== generation) throw new BridgeError(409, '登录已取消，请重试。');
                if (!stored) return { pending: true };
                await writePrivate(user.authFile, stored);
                if (user.pending !== pending || user.generation !== generation) throw new BridgeError(409, '登录已取消，请重试。');
                user.stored = stored;
                user.pending = null;
                return this.status(user);
            })().finally(() => { user.poll = null; });
        }
        return user.poll;
    }

    async logout(user) {
        if (user.loggingOut) return user.loggingOut;
        user.generation++;
        user.pending = null;
        user.stored = null;
        for (const controller of user.controllers) controller.abort();
        const operation = (async () => {
            // Invalidated requests cannot restore the account. Wait for any file writes before unlinking it.
            await Promise.allSettled([user.poll, user.refresh].filter(Boolean));
            await fs.unlink(user.authFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
            return this.status(user);
        })();
        user.loggingOut = operation;
        try { return await operation; }
        finally { if (user.loggingOut === operation) user.loggingOut = null; }
    }

    async handle(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const send = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); } };
        try {
            // This port accepts only the Tavern server. Browsers have a separate CSRF-protected control API.
            if (req.headers.origin || req.headers['sec-fetch-site']) throw new BridgeError(403, '此接口只供本机酒馆服务使用。');
            const expectedHost = new URL(this.baseURL).host;
            if (req.headers.host !== expectedHost) throw new BridgeError(403, '本机接口 Host 无效。');
            const key = String(req.headers.authorization || '').replace(/^Bearer /, '');
            const user = [...this.users.values()].find(value => equal(value.key, key));
            if (!user) throw new BridgeError(401, '本机连接密钥无效。');
            const route = new URL(req.url, this.baseURL).pathname;
            if (req.method === 'GET' && route === '/v1/models') {
                const models = await this.provider.models(await this.credentials(user));
                send(200, { object: 'list', data: models.map(model => ({ id: model.id, object: 'model', owned_by: 'workbuddy' })) });
                return;
            }
            if (req.method !== 'POST' || route !== '/v1/chat/completions') throw new BridgeError(404, '接口不存在。');
            if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new BridgeError(415, '请求必须使用 application/json。');
            const input = await requestJSON(req);
            const body = normalizeChat(input);
            const stored = await this.credentials(user);
            if (user.stored !== stored || user.loggingOut) throw new BridgeError(401, '账号已退出，请重新连接。');
            const controller = new AbortController();
            this.controllers.add(controller);
            user.controllers.add(controller);
            const cancel = () => { if (!res.writableEnded) controller.abort(); };
            req.once('aborted', cancel);
            res.once('close', cancel);
            const timer = setTimeout(() => controller.abort(), 180_000);
            try {
                const upstream = await this.provider.chat(stored, body, controller.signal);
                if (!upstream.ok) {
                    await upstream.body?.cancel();
                    throw new BridgeError(upstream.status === 429 ? 429 : upstream.status === 401 ? 401 : 502, `腾讯模型返回 HTTP ${upstream.status}。`);
                }
                if (!String(upstream.headers.get('content-type') || '').includes('text/event-stream')) {
                    await upstream.body?.cancel();
                    throw new BridgeError(502, '腾讯模型没有返回流式数据，可能额度不足或接口已变化。');
                }
                if (input.stream === true) {
                    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no' });
                    for await (const chunk of chunks(upstream.body)) {
                        if (res.destroyed) break;
                        if (!res.write(`data: ${JSON.stringify(chunk)}\n\n`)) {
                            await new Promise(resolve => { const done = () => { res.off('drain', done); res.off('close', done); resolve(); }; res.once('drain', done); res.once('close', done); });
                        }
                    }
                    if (!res.destroyed) res.end('data: [DONE]\n\n');
                } else send(200, await collect(upstream.body, input.model));
            } catch (error) {
                if (controller.signal.aborted) throw new BridgeError(504, '请求已取消或等待超时。');
                throw error;
            } finally {
                clearTimeout(timer); this.controllers.delete(controller); req.off('aborted', cancel); res.off('close', cancel);
                user.controllers.delete(controller);
                controller.abort();
            }
        } catch (error) {
            if (res.destroyed) return;
            if (res.headersSent) res.end(`data: ${JSON.stringify(errorBody(error))}\n\ndata: [DONE]\n\n`);
            else send(statusCode(error), errorBody(error));
        }
    }
}

export { errorBody, statusCode };
