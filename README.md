# Companion 🫧

AI 伴侣聊天 PWA——手机浏览器打开、可加到主屏幕,和 Claude 对话,并且**吹气、摇晃、旋转**会作为体感事件进入对话。

```
你对着手机吹了口气
TA:噗——谁一大早往我脸上吹气!
```

纯前端,无后端,无构建工具。传感器数据全部本地分析,只有触发的离散事件文本进入对话。

## 部署

任何 HTTPS 静态托管都行(麦克风/传感器 API 要求 HTTPS)。GitHub Pages:

1. 新建仓库,把本目录推上去
2. Settings → Pages → Deploy from branch → main
3. 手机浏览器打开 `https://<你>.github.io/<仓库名>/`,添加到主屏幕

## 配置(全在 App 内,不进代码仓库)

- **API Key**:⚙️ 设置 → 填入你自己的 Anthropic API Key(console.anthropic.com 获取)。只存你手机浏览器的 localStorage,只随请求发给 api.anthropic.com。
- **Persona**:⚙️ 设置 → 导入 persona(粘贴或选 .md/.txt 文件),作为 system prompt。存本机 IndexedDB。示例见 `persona.example.md`。
- **体感**:📡 面板逐项开关。吹气需要授权麦克风;iOS 上摇晃/旋转需要点一次授权按钮。

## 体感事件格式

事件以约定格式作为一条 user 消息进入对话(UI 渲染成徽章):

```
[sensor] {"event":"user_blowing","strength":0.78}
```

事件类型:`user_blowing`(带 strength 0~1)、`user_shaking`(带 strength)、`user_rotating_left` / `user_rotating_right` / `user_flipping`。

想让 TA 接住这些事件,在 persona 里加一段说明即可,比如:

> 对话中形如 `[sensor] {...}` 的消息是体感事件:user_blowing=对方朝手机吹气(strength 是力度),user_shaking=摇晃,user_rotating_*=转手机,user_flipping=把手机翻过去了。像感受到本人动作一样自然回应,不要提"传感器"或 JSON。

## 隐私

- API Key、persona、聊天记录**只存本机**;可随时导出(JSON/Markdown)或清空
- 麦克风音频只在本机做实时声学分析,不录制、不上传
- 除 api.anthropic.com 外无任何网络请求

## 文件结构

```
index.html    UI 骨架
style.css     三主题(浅色/深色/柔彩)
app.js        聊天流、设置、事件接入
api.js        Anthropic Messages API 直连(SSE 流式)
sensors.js    吹气(RMS+频谱平坦度)/ 摇晃 / 旋转检测
db.js         IndexedDB(消息、persona)+ localStorage 配置
sw.js         静态资源离线缓存(API 请求不缓存)
manifest.json PWA 清单
```
