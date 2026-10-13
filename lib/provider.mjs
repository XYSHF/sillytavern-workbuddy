import { randomUUID } from 'node:crypto';

export class BridgeError extends Error {
    constructor(status, message) { super(message); this.status = status; }
}

// This is an unofficial client of the domestic service. No user-selected upstream.
const BASE = 'https://copilot.tencent.com';
const ORIGIN = 'https://www.codebuddy.cn';
const AUTH_HOSTS = new Set(['copilot.tencent.com', 'www.codebuddy.cn']);

export function validateLoginURL(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !AUTH_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
        throw new BridgeError(502, '登录地址不是已知的腾讯官方地址。');
    }
    return url.href;
}

export class Provider {
    constructor(fetchImpl = globalThis.fetch) { this.fetch = fetchImpl; }

    headers(stored, extra = {}) {
        const headers = {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/plain, */*',
            'X-Requested-With': 'XMLHttpRequest',
            Origin: ORIGIN, Referer: `${ORIGIN}/`,
            'User-Agent': 'CLI/2.143.1 CodeBuddy/2.143.1',
            'X-Client-ID': 'codebuddy-cli', 'X-Client-Version': '2.143.1', 'X-Product': 'SaaS',
        };
        for (const [field, header, absent] of [
            [stored?.auth?.accessToken, 'Authorization', 'X-No-Authorization'],
            [stored?.account?.uid, 'X-User-Id', 'X-No-User-Id'],
            [stored?.account?.enterpriseId, 'X-Enterprise-Id', 'X-No-Enterprise-Id'],
            [stored?.auth?.domain, 'X-Domain', 'X-No-Department-Info'],
        ]) {
            if (field) headers[header] = header === 'Authorization' ? `Bearer ${field}` : String(field);
            else headers[absent] = '1';
        }
        if (stored?.auth?.refreshToken) headers['X-Refresh-Token'] = stored.auth.refreshToken;
        return { ...headers, ...extra };
    }

    async json(route, { method = 'GET', stored, body, extra, pending = false } = {}) {
        let response;
        try {
            response = await this.fetch(`${BASE}${route}`, {
                method, headers: this.headers(stored, extra), redirect: 'error',
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
        } catch { throw new BridgeError(502, '连接腾讯服务失败，请稍后重试。'); }
        if (!response.ok) throw new BridgeError(response.status === 401 ? 401 : 502, `腾讯服务返回 HTTP ${response.status}。`);
        let envelope;
        try { envelope = await response.json(); } catch { throw new BridgeError(502, '腾讯服务返回了无法识别的数据。'); }
        if (pending && envelope.code === 11217) return null;
        if (envelope.code !== 0) {
            // Never reflect an upstream error body, which can contain credentials or prompts.
            const code = Number.isSafeInteger(envelope.code) ? envelope.code : 'unknown';
            throw new BridgeError(502, `腾讯服务拒绝了请求（代码 ${code}）。`);
        }
        return envelope.data;
    }

    async loginStart() {
        const result = await this.json('/v2/plugin/auth/state?platform=VSCode', { method: 'POST', body: {} });
        if (typeof result?.state !== 'string' || result.state.length > 1024) throw new BridgeError(502, '登录状态无效。');
        return { state: result.state, authUrl: validateLoginURL(result.authUrl) };
    }

    token(token, previous = {}) {
        if (!token?.accessToken || !(token.refreshToken || previous.refreshToken)) throw new BridgeError(502, '授权未返回完整凭据。');
        return {
            accessToken: token.accessToken, refreshToken: token.refreshToken || previous.refreshToken,
            expiresAt: Math.floor(Date.now() / 1000) + (Number(token.expiresIn) || 3600),
            domain: token.domain ?? previous.domain ?? '',
        };
    }

    async loginPoll(state) {
        const token = await this.json(`/v2/plugin/auth/token?state=${encodeURIComponent(state)}`, { pending: true });
        if (!token) return null;
        const stored = { edition: 'cn', auth: this.token(token) };
        const account = await this.json(`/v2/plugin/login/account?state=${encodeURIComponent(state)}`, { stored });
        if (!account?.uid) throw new BridgeError(502, '未获取到账号信息。');
        stored.account = { uid: String(account.uid), enterpriseId: String(account.enterpriseId || ''), nickname: String(account.nickname || 'WorkBuddy 用户') };
        return stored;
    }

    async refresh(stored) {
        const result = await this.json('/v2/plugin/auth/token/refresh', {
            method: 'POST', stored, extra: { 'X-Auth-Refresh-Source': 'workbuddy' },
        });
        return { ...stored, auth: this.token(result, stored.auth) };
    }

    async models(stored) {
        const data = await this.json('/v2/enterprises/personal/models', { stored });
        if (!Array.isArray(data?.models)) throw new BridgeError(502, '模型列表格式已变化。');
        return data.models.filter(model => typeof model.id === 'string').map(model => ({
            id: model.id, name: String(model.name || model.id),
            credits: typeof model.credits === 'string' ? model.credits : '',
            maxInputTokens: Number(model.maxInputTokens) || undefined,
            maxOutputTokens: Number(model.maxOutputTokens) || undefined,
        }));
    }

    async chat(stored, body, signal) {
        try {
            return await this.fetch(`${BASE}/v2/chat/completions`, {
                method: 'POST', headers: this.headers(stored, {
                    Accept: 'text/event-stream', 'X-Request-ID': randomUUID(), 'X-Trace-ID': randomUUID(),
                }), body: JSON.stringify(body), signal, redirect: 'error',
            });
        } catch {
            if (signal.aborted) throw new BridgeError(504, '请求已取消或等待超时。');
            throw new BridgeError(502, '连接腾讯模型失败，请稍后重试。');
        }
    }
}
