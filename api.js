/* api.js — Anthropic Messages API 浏览器直连(SSE 流式)
 * 唯一的网络出口。key 由用户在设置里填,存 localStorage,只随本请求发给 api.anthropic.com。
 */
"use strict";

const API = (() => {
  const ENDPOINT = "https://api.anthropic.com/v1/messages";

  /**
   * 流式发送对话。
   * @param {Object} opts
   *   apiKey, model, system(persona 文本,可空), messages([{role, content}]),
   *   onText(delta)  — 每收到一段文本增量
   *   signal         — AbortSignal
   * @returns {Promise<string>} 完整回复文本
   */
  async function chat({ apiKey, model, system, messages, onText, signal }) {
    const body = {
      model: model || "claude-sonnet-5",
      max_tokens: 4096,
      stream: true,
      messages,
    };
    if (system) body.system = system;

    const resp = await fetch(ENDPOINT, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        // 官方支持的浏览器直连开关(key 属于用户自己,风险自担模式)
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      let msg = `HTTP ${resp.status}`;
      try { msg = (await resp.json()).error?.message || msg; } catch (_) {}
      throw new Error(msg);
    }

    // 解析 SSE:按行切,取 data: 里的 JSON,拼 content_block_delta 的 text_delta
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "", full = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop(); // 尾部可能是半行,留到下一轮
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        let ev;
        try { ev = JSON.parse(data); } catch (_) { continue; }
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
          full += ev.delta.text;
          onText && onText(ev.delta.text);
        } else if (ev.type === "error") {
          throw new Error(ev.error?.message || "stream error");
        }
      }
    }
    return full;
  }

  return { chat };
})();
