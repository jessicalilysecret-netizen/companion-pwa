/* app.js — 主逻辑:聊天流、设置、传感器事件接入对话 */
"use strict";

(() => {
  const $ = sel => document.querySelector(sel);
  const chatEl = $("#chat"), inputEl = $("#input"), sendBtn = $("#btn-send");

  // 事件消息的约定格式:一条 user 消息,渲染成徽章
  const SENSOR_PREFIX = "[sensor] ";
  const SENSOR_LABEL = {
    user_blowing: s => `🌬️ 吹气 ${s}`,
    user_shaking: s => `📳 摇晃 ${s}`,
    user_rotating_left: () => "↪️ 左转",
    user_rotating_right: () => "↩️ 右转",
    user_flipping: () => "🙃 翻转",
  };

  let busy = false;         // 一次只跑一个请求
  let pendingImage = null;  // 待发送图片的 dataURL(已压缩),或 null

  // ---------- 渲染 ----------
  function render(msg) {
    const div = document.createElement("div");
    if (msg.kind === "sensor") {
      div.className = "msg sensor";
      let label = msg.content;
      try {
        const j = JSON.parse(msg.content.slice(SENSOR_PREFIX.length));
        label = (SENSOR_LABEL[j.event] || (() => j.event))(j.strength ?? "");
      } catch (_) {}
      div.innerHTML = `<span class="sensor-badge"></span>`;
      div.firstChild.textContent = label;
    } else if (msg.kind === "error") {
      div.className = "msg err";
      div.innerHTML = `<div class="bubble"></div>`;
      div.firstChild.textContent = msg.content;
    } else {
      div.className = "msg " + (msg.role === "user" ? "me" : "ai");
      div.innerHTML = `<div class="bubble"></div>`;
      const bub = div.firstChild;
      if (msg.image) {
        const im = document.createElement("img");
        im.src = msg.image;
        bub.appendChild(im);
      }
      if (msg.content) {
        const span = document.createElement("span");
        span.textContent = msg.content;
        bub.appendChild(span);
      }
    }
    chatEl.appendChild(div);
    chatEl.scrollTop = chatEl.scrollHeight;
    return div;
  }

  async function loadHistory() {
    (await DB.allMessages()).forEach(render);
  }

  // ---------- 发送 ----------
  // 把一条存储消息转成 Anthropic content blocks 数组
  function msgToBlocks(m) {
    const blocks = [];
    if (m.image) {
      const comma = m.image.indexOf(",");
      const media = (m.image.match(/data:(.*?);/) || [])[1] || "image/jpeg";
      blocks.push({ type: "image", source: { type: "base64", media_type: media, data: m.image.slice(comma + 1) } });
    }
    if (m.content) blocks.push({ type: "text", text: m.content });
    if (!blocks.length) blocks.push({ type: "text", text: "(空)" });
    return blocks;
  }

  async function buildRequestMessages() {
    const maxTurns = CFG.get("history", 30);
    const all = (await DB.allMessages()).filter(m => m.kind !== "error");
    let msgs = all.slice(-maxTurns * 2);
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    // 合并相邻同角色消息;content 统一为 blocks 数组(API 接受)
    const merged = [];
    for (const m of msgs) {
      const blocks = msgToBlocks(m);
      const last = merged[merged.length - 1];
      if (last && last.role === m.role) last.content.push(...blocks);
      else merged.push({ role: m.role, content: blocks });
    }
    return merged;
  }

  async function send(content, kind, image) {
    const apiKey = CFG.get("key", "");
    if (!apiKey) {
      render({ kind: "error", content: "先在 ⚙️ 设置里填 API Key" });
      openSheet("#settings-panel");
      return;
    }
    const userMsg = { role: "user", content, kind, image: image || null, ts: Date.now() };
    await DB.addMessage(userMsg);
    render(userMsg);

    if (busy) return; // 请求进行中:消息已入库,本轮回复会带上它之前的内容,下一轮再覆盖
    busy = true;

    const typing = document.createElement("div");
    typing.className = "typing";
    typing.textContent = "对方正在输入";
    chatEl.appendChild(typing);
    chatEl.scrollTop = chatEl.scrollHeight;

    const aiDiv = render({ role: "assistant", content: "", kind: "text" });
    const bubble = aiDiv.firstChild;
    aiDiv.hidden = true;

    try {
      const persona = await DB.getPersona();
      const full = await API.chat({
        apiKey,
        model: CFG.get("model", "claude-sonnet-5"),
        system: persona || undefined,
        messages: await buildRequestMessages(),
        onText: delta => {
          if (aiDiv.hidden) { aiDiv.hidden = false; typing.remove(); }
          bubble.textContent += delta;
          chatEl.scrollTop = chatEl.scrollHeight;
        },
      });
      typing.remove();
      aiDiv.hidden = false;
      await DB.addMessage({ role: "assistant", content: full, kind: "text", ts: Date.now() });
    } catch (e) {
      typing.remove();
      aiDiv.remove();
      render({ kind: "error", content: "请求失败:" + e.message });
    } finally {
      busy = false;
    }
  }

  sendBtn.addEventListener("click", () => {
    const t = inputEl.value.trim();
    const img = pendingImage;
    if (!t && !img) return;
    inputEl.value = "";
    clearPendingImage();
    autoGrow();
    send(t, img ? "image" : "text", img);
  });

  // ---- 图片:选取 → 本机压缩 → 预览 → 发送 ----
  function resizeImage(file, maxDim = 1024, quality = 0.82) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let w = img.naturalWidth, h = img.naturalHeight;
        const scale = Math.min(1, maxDim / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        try { resolve(c.toDataURL("image/jpeg", quality)); }
        catch (e) { reject(e); }
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("这张图读不出来(格式可能不支持)")); };
      img.src = url;
    });
  }
  function clearPendingImage() {
    pendingImage = null;
    $("#pending-image").hidden = true;
    $("#pending-thumb").removeAttribute("src");
    autoGrow();
  }
  $("#btn-image").addEventListener("click", () => $("#image-file").click());
  $("#image-file").addEventListener("change", async e => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      pendingImage = await resizeImage(f);
      $("#pending-thumb").src = pendingImage;
      $("#pending-image").hidden = false;
      autoGrow();
    } catch (err) {
      render({ kind: "error", content: "图片处理失败:" + err.message });
    }
  });
  $("#btn-cancel-image").addEventListener("click", clearPendingImage);
  inputEl.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendBtn.click();
    }
  });
  function autoGrow() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
    sendBtn.disabled = !inputEl.value.trim() && !pendingImage;
  }
  inputEl.addEventListener("input", autoGrow);

  // ---------- 传感器接入 ----------
  Sensors.onEvent(ev => {
    if (CFG.get("mute", false)) return;
    if (!navigator.onLine) return;
    send(SENSOR_PREFIX + JSON.stringify(ev), "sensor");
  });
  Sensors.onLive(txt => { const el = $("#sensor-live"); if (el) el.textContent = txt; });

  function bindSensorToggle(id, cfgKey, apply) {
    const el = $(id);
    el.checked = CFG.get(cfgKey, false);
    apply(el.checked, true);
    el.addEventListener("change", async () => {
      const ok = await apply(el.checked, false);
      if (ok === false) el.checked = false;
      CFG.set(cfgKey, el.checked);
    });
  }

  bindSensorToggle("#s-blow", "sensor.blow", (on, silent) => {
    if (on) return silent ? undefined : Sensors.startBlow(); // 初始加载不自动开麦,等用户碰开关
    Sensors.stopBlow();
  });
  bindSensorToggle("#s-shake", "sensor.shake", on => { Sensors.setShake(on); });
  bindSensorToggle("#s-rotate", "sensor.rotate", on => { Sensors.setRotate(on); });
  $("#s-mute").checked = CFG.get("mute", false);
  $("#s-mute").addEventListener("change", e => CFG.set("mute", e.target.checked));
  $("#s-blow-sense").value = CFG.get("blowSense", 5);
  Sensors.setSensitivity(CFG.get("blowSense", 5));
  $("#s-blow-sense").addEventListener("input", e => {
    CFG.set("blowSense", +e.target.value);
    Sensors.setSensitivity(e.target.value);
  });

  // iOS 运动权限按钮
  if (Sensors.needsIOSPermission()) {
    const btn = $("#btn-motion-perm");
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      const ok = await Sensors.requestIOSPermission();
      btn.textContent = ok ? "✓ 已授权" : "授权被拒,请到 设置→Safari 里开启";
      if (ok) btn.disabled = true;
    });
  }

  // ---------- 面板开合 ----------
  function openSheet(sel) { $(sel).hidden = false; $("#sheet-mask").hidden = false; }
  function closeSheets() {
    document.querySelectorAll(".sheet").forEach(s => s.hidden = true);
    $("#sheet-mask").hidden = true;
  }
  $("#btn-sensors").addEventListener("click", () => openSheet("#sensor-panel"));
  $("#btn-settings").addEventListener("click", () => openSheet("#settings-panel"));
  $("#sheet-mask").addEventListener("click", closeSheets);
  document.querySelectorAll(".sheet-close").forEach(b => b.addEventListener("click", closeSheets));

  // ---------- 设置 ----------
  const keyEl = $("#set-key"), modelEl = $("#set-model"), histEl = $("#set-history");
  keyEl.value = CFG.get("key", "");
  modelEl.value = CFG.get("model", "claude-sonnet-5");
  histEl.value = CFG.get("history", 30);
  keyEl.addEventListener("change", () => CFG.set("key", keyEl.value.trim()));
  modelEl.addEventListener("change", () => CFG.set("model", modelEl.value.trim() || "claude-sonnet-5"));
  histEl.addEventListener("change", () => CFG.set("history", Math.max(2, +histEl.value || 30)));

  // persona
  async function refreshPersonaStatus() {
    const p = await DB.getPersona();
    $("#persona-status").textContent = p
      ? `已导入 persona,${p.length} 字。仅存本机,随请求作为 system prompt 发送。`
      : "未导入 persona(将以默认 Claude 身份对话)。";
  }
  $("#btn-persona-file").addEventListener("click", () => $("#persona-file").click());
  $("#persona-file").addEventListener("change", async e => {
    const f = e.target.files[0];
    if (!f) return;
    await DB.setPersona(await f.text());
    e.target.value = "";
    refreshPersonaStatus();
  });
  $("#btn-persona-paste").addEventListener("click", async () => {
    const t = prompt("粘贴 persona 文本:");
    if (t) { await DB.setPersona(t); refreshPersonaStatus(); }
  });
  $("#btn-persona-view").addEventListener("click", async () => {
    const p = await DB.getPersona();
    alert(p ? p.slice(0, 2000) + (p.length > 2000 ? "\n\n…(仅预览前 2000 字)" : "") : "(空)");
  });
  $("#btn-persona-clear").addEventListener("click", async () => {
    if (confirm("清除本机保存的 persona?")) { await DB.clearPersona(); refreshPersonaStatus(); }
  });
  refreshPersonaStatus();

  // 导出 / 清空
  function download(name, text, type) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  $("#btn-export-json").addEventListener("click", async () => {
    download("chat.json", JSON.stringify(await DB.allMessages(), null, 2), "application/json");
  });
  $("#btn-export-md").addEventListener("click", async () => {
    const md = (await DB.allMessages()).map(m => {
      const who = m.kind === "sensor" ? "⚡" : m.role === "user" ? "我" : "TA";
      return `**${who}** (${new Date(m.ts).toLocaleString()})\n\n${m.content}\n`;
    }).join("\n---\n\n");
    download("chat.md", md, "text/markdown");
  });
  $("#btn-clear-chat").addEventListener("click", async () => {
    if (confirm("清空本机聊天记录?不可恢复。")) {
      await DB.clearMessages();
      chatEl.innerHTML = "";
    }
  });

  // 主题
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    if (t === "tint") {
      document.documentElement.style.setProperty("--accent", CFG.get("tint", "#e8a0a8"));
    } else {
      document.documentElement.style.removeProperty("--accent");
    }
    $("#meta-theme").content = getComputedStyle(document.body).backgroundColor;
  }
  document.querySelectorAll(".theme-btn").forEach(b => b.addEventListener("click", () => {
    CFG.set("theme", b.dataset.theme);
    applyTheme(b.dataset.theme);
  }));
  $("#set-tint").value = CFG.get("tint", "#e8a0a8");
  $("#set-tint").addEventListener("change", e => {
    CFG.set("tint", e.target.value);
    if (CFG.get("theme") === "tint") applyTheme("tint");
  });
  applyTheme(CFG.get("theme", "light"));

  // ---------- 在线状态 ----------
  function updateOnline() {
    const off = !navigator.onLine;
    $("#offline-banner").hidden = !off;
    $("#conn-dot").classList.toggle("off", off);
  }
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();

  // ---------- service worker ----------
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  loadHistory();
  autoGrow();
})();
