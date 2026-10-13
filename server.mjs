import { Bridge, errorBody, statusCode } from './lib/bridge.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncFrontend } from './lib/frontend-sync.mjs';

export const info = { id: 'workbuddy', name: 'WorkBuddy local bridge', description: 'Per-user local connection to the domestic WorkBuddy service' };
let bridge;

export async function init(router) {
    try { await syncFrontend(path.dirname(fileURLToPath(import.meta.url))); }
    catch { console.warn('[WorkBuddy] 界面同步失败，请重新运行本插件的安装器。'); }
    bridge = new Bridge();
    await bridge.start();
    router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
    const route = handler => async (req, res) => {
        try { res.json(await handler(await bridge.user(req.user?.directories?.root))); }
        catch (error) { res.status(statusCode(error)).json(errorBody(error)); }
    };
    // All control operations use POST and Tavern's existing session and CSRF middleware.
    router.post('/status', route(user => bridge.status(user)));
    router.post('/login/start', route(user => bridge.loginStart(user)));
    router.post('/login/poll', route(user => bridge.loginPoll(user)));
    router.post('/logout', route(user => bridge.logout(user)));
    router.post('/models', route(async user => ({ models: await bridge.provider.models(await bridge.credentials(user)) })));
    router.post('/connection', route(async user => {
        await bridge.credentials(user);
        // Only a local bridge key reaches the browser; Tencent tokens stay on the server.
        return { baseURL: bridge.baseURL, key: user.key };
    }));
}

export async function exit() { await bridge?.close(); bridge = null; }
