import { getRequestHeaders, saveSettingsDebounced } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';
import { SECRET_KEYS, writeSecret } from '../../../secrets.js';

const API = '/api/plugins/workbuddy';
const settings = () => (extension_settings.workbuddy_local ||= {});
let panel, modelSelect, statusText, loginLink, polling = false, loggedIn = false;

async function api(route) {
    let response;
    try { response = await fetch(`${API}${route}`, { method: 'POST', headers: getRequestHeaders(), body: '{}' }); }
    catch { throw new Error('酒馆服务无法连接，请检查它是否仍在运行。'); }
    if (response.status === 404) throw new Error('服务端组件未启动。请在酒馆文件夹运行安装命令，再重启酒馆。');
    let data;
    try { data = await response.json(); } catch { throw new Error(`请求失败（HTTP ${response.status}）。`); }
    if (!response.ok) throw new Error(data.error?.message || `请求失败（HTTP ${response.status}）。`);
    return data;
}

function setStatus(text) { statusText.textContent = text; }
function report(error) { setStatus(error.message); }

async function refreshModels() {
    const data = await api('/models');
    modelSelect.replaceChildren();
    for (const model of data.models) {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = `${model.name} (${model.id})${model.credits ? ` · ${model.credits}` : ''}`;
        modelSelect.append(option);
    }
    const preferred = settings().model || 'hy3';
    if ([...modelSelect.options].some(option => option.value === preferred)) modelSelect.value = preferred;
    modelSelect.disabled = !modelSelect.options.length;
    panel.querySelector('[data-action="connect"]').disabled = !modelSelect.options.length;
}

function setInput(selector, value) {
    if (!$(selector).length) throw new Error('酒馆版本缺少需要的连接设置，请使用当前稳定版。');
    $(selector).val(value).trigger('input');
}

async function applyConnection({ silent = false } = {}) {
    if (!silent) setStatus('正在连接酒馆…');
    const model = silent ? settings().model : modelSelect.value;
    if (!model) throw new Error('请先选择模型。');
    const connection = await api('/connection');
    const url = new URL(connection.baseURL);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/v1') throw new Error('服务端返回的本机地址无效。');
    if (!silent) {
        const id = await writeSecret(SECRET_KEYS.CUSTOM, connection.key, 'WorkBuddy 本机连接');
        if (!id) throw new Error('酒馆未能保存本机连接密钥。');
        $('#main_api').val('openai').trigger('change');
        $('#chat_completion_source').val('custom').trigger('change');
        for (const field of ['custom_include_body', 'custom_include_headers', 'custom_exclude_body']) {
            oai_settings[field] = '';
            if ($(`#${field}`).length) $(`#${field}`).val('').trigger('input');
        }
        // A selected connection profile can overwrite these settings after reload.
        if (extension_settings.connectionManager) extension_settings.connectionManager.selectedProfile = '';
    }
    setInput('#custom_api_url_text', connection.baseURL);
    setInput('#custom_model_id', model);
    Object.assign(settings(), { model, baseURL: connection.baseURL });
    saveSettingsDebounced();
    if (!silent) {
        setStatus(`已接好 ${model}。回到聊天页即可使用。`);
        if (typeof toastr !== 'undefined') toastr.success('WorkBuddy 已接入酒馆');
        $('#api_button_openai').trigger('click');
    }
}

async function updateStatus() {
    const data = await api('/status');
    loggedIn = data.loggedIn;
    panel.querySelector('[data-action="login"]').disabled = loggedIn || polling;
    panel.querySelector('[data-action="logout"]').disabled = !loggedIn && !polling;
    panel.querySelector('[data-action="models"]').disabled = !loggedIn;
    modelSelect.disabled = !loggedIn;
    panel.querySelector('[data-action="connect"]').disabled = !loggedIn;
    setStatus(loggedIn ? `已登录：${data.nickname}` : '还未登录，点击“登录 WorkBuddy”。');
    if (loggedIn) await refreshModels();
    else modelSelect.replaceChildren();
    return data;
}

async function login() {
    if (polling || loggedIn) return;
    // Create the window during the click; phone browsers may block an asynchronous popup.
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    let navigated = false;
    polling = true;
    panel.querySelector('[data-action="login"]').disabled = true;
    try {
        const data = await api('/login/start');
        const url = new URL(data.authUrl);
        if (url.protocol !== 'https:' || !['copilot.tencent.com', 'www.codebuddy.cn'].includes(url.hostname) || url.username || url.password || url.port) throw new Error('登录地址无效。');
        loginLink.href = url.href;
        loginLink.hidden = false;
        if (popup) { popup.location.replace(url.href); navigated = true; }
        setStatus('在腾讯页面完成登录，然后返回这里。无需复制任何 Token。');
        panel.querySelector('[data-action="logout"]').disabled = false;
        const deadline = Date.now() + 5 * 60_000;
        while (polling && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 2500));
            if (!polling) return;
            const result = await api('/login/poll');
            if (!result.pending) {
                polling = false;
                loginLink.hidden = true;
                await updateStatus();
                setStatus('登录成功。选择模型后点击“接入酒馆”。');
                return;
            }
        }
        if (polling) throw new Error('登录链接已过期，请再次点击登录。');
    } catch (error) {
        report(error);
        if (popup && !navigated) popup.close();
    } finally {
        polling = false;
        panel.querySelector('[data-action="login"]').disabled = loggedIn;
    }
}

async function logout() {
    polling = false;
    await api('/logout');
    loginLink.hidden = true;
    await updateStatus();
    setStatus('已从本插件退出。当前酒馆连接将无法继续调用此账号。');
}

jQuery(async () => {
    panel = document.createElement('div');
    panel.id = 'workbuddy-local-settings';
    panel.innerHTML = `<div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>WorkBuddy 本机连接</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content">
            <p class="wb-status" role="status" aria-live="polite">正在检查连接…</p>
            <div class="wb-buttons"><button type="button" class="menu_button" data-action="login">登录 WorkBuddy</button><button type="button" class="menu_button" data-action="logout" disabled>退出 / 取消登录</button></div>
            <a class="wb-login-link" target="_blank" rel="noopener noreferrer" hidden>打开腾讯登录页面</a>
            <label class="wb-model-label">选择模型<select class="text_pole" disabled></select></label>
            <div class="wb-buttons"><button type="button" class="menu_button" data-action="connect" disabled>接入酒馆</button><button type="button" class="menu_button" data-action="models" disabled>刷新模型</button></div>
            <small>对话会发送给腾讯及所选模型的服务方。此插件为非官方适配；价格和额度以服务实际结算为准。</small>
        </div></div>`;
    document.querySelector('#extensions_settings').append(panel);
    statusText = panel.querySelector('.wb-status');
    loginLink = panel.querySelector('.wb-login-link');
    modelSelect = panel.querySelector('select');
    const actions = { login, logout, models: async () => { await updateStatus(); }, connect: applyConnection };
    for (const button of panel.querySelectorAll('button')) {
        button.addEventListener('click', () => { Promise.resolve(actions[button.dataset.action]()).catch(report); });
    }
    try {
        const oldURL = settings().baseURL;
        const selected = $('#main_api').val() === 'openai' && oai_settings.chat_completion_source === 'custom' && oai_settings.custom_url === oldURL;
        const data = await updateStatus();
        // A fresh local port after restarting Tavern is refreshed only for the already selected WorkBuddy connection.
        if (selected && data.loggedIn && settings().model) await applyConnection({ silent: true });
    } catch (error) { report(error); }
});
