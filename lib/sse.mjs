import { BridgeError } from './provider.mjs';

export async function* chunks(body) {
    if (!body) throw new BridgeError(502, '腾讯服务没有返回内容。');
    const decoder = new TextDecoder();
    let buffer = '', ended = false;
    function parse(event) {
        const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!data) return undefined;
        if (data === '[DONE]') return null;
        let chunk;
        try { chunk = JSON.parse(data); } catch { throw new BridgeError(502, '模型流式数据格式无效。'); }
        if (chunk.error || (Object.hasOwn(chunk, 'code') && chunk.code !== 0)) throw new BridgeError(502, '腾讯模型在生成过程中返回了错误。');
        if (!Array.isArray(chunk.choices) && !chunk.usage) throw new BridgeError(502, '模型响应协议已变化。');
        for (const choice of chunk.choices || []) if (choice.finish_reason === '') choice.finish_reason = null;
        return chunk;
    }
    for await (const bytes of body) {
        buffer += decoder.decode(bytes, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
            const event = buffer.slice(0, match.index);
            buffer = buffer.slice(match.index + match[0].length);
            if (event.length > 1_048_576) throw new BridgeError(502, '模型单条响应过大。');
            const result = parse(event);
            if (result === null) { ended = true; break; }
            if (result !== undefined) yield result;
        }
        if (ended) break;
        if (buffer.length > 1_048_576) throw new BridgeError(502, '模型单条响应过大。');
    }
    if (!ended) throw new BridgeError(502, '模型连接提前中断，请重试。');
}

export async function collect(body, model) {
    const message = { role: 'assistant', content: '' };
    let id, usage, created, finish = null;
    const tools = new Map();
    for await (const chunk of chunks(body)) {
        id = chunk.id || id; created = chunk.created || created; usage = chunk.usage || usage;
        for (const choice of chunk.choices || []) {
            if ((choice.index || 0) !== 0) continue;
            const delta = choice.delta || {};
            if (typeof delta.content === 'string') message.content += delta.content;
            if (typeof delta.reasoning_content === 'string') message.reasoning_content = (message.reasoning_content || '') + delta.reasoning_content;
            for (const call of delta.tool_calls || []) {
                const current = tools.get(call.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
                if (call.id) current.id = call.id;
                if (call.type) current.type = call.type;
                if (call.function?.name) current.function.name += call.function.name;
                if (call.function?.arguments) current.function.arguments += call.function.arguments;
                tools.set(call.index, current);
            }
            finish = choice.finish_reason || finish;
        }
    }
    if (tools.size) message.tool_calls = [...tools].sort(([a], [b]) => a - b).map(([, call]) => call);
    return { id: id || 'workbuddy', object: 'chat.completion', created: created || Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message, finish_reason: finish || (tools.size ? 'tool_calls' : 'stop') }], ...(usage ? { usage } : {}) };
}
