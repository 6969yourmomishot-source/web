# 前端地基 · Dashboard 骨架

一个排版精良、跑虚拟数据的前端骨架，用于先把「部署 + 备份」的地基搭好，
之后往里填真实项目即可，无需重搭环境。

- **零依赖**：仅用 Python 标准库起静态服务器，前端为原生 HTML/CSS/JS。
- **可分享**：部署到 Railway 后会得到一个公开网址，发给谁都能打开。
- **自动备份/部署**：与 GitHub 联动，每次 `git push` Railway 自动重新部署。
- **深/浅色**：内置主题切换，配色对比度经过校验。

## 目录结构

```
web-frontend/
├─ public/            前端本体
│  ├─ index.html      页面结构
│  ├─ styles.css      样式与配色令牌
│  ├─ app.js          渲染逻辑（KPI / 图表 / 表格）
│  └─ mock.js         虚拟数据（之后换成真实 API）
├─ server.py          静态服务器（监听 0.0.0.0:$PORT）
├─ railway.json       Railway 部署配置
├─ Procfile           启动命令
├─ requirements.txt   （空，仅用于让 Railway 识别为 Python 项目）
└─ runtime.txt        Python 版本
```

## 本地预览

需要已安装 Python 3：

```bash
python server.py
```

然后浏览器打开 http://localhost:8000

## 部署到 Railway

1. 把本项目推送到 GitHub 仓库。
2. 在 Railway 新建项目 → Deploy from GitHub repo → 选择该仓库。
3. Railway 自动识别为 Python 项目并用 `python server.py` 启动。
4. 在 Settings → Networking → Generate Domain 生成公开网址。

以后改动只要 `git push`，Railway 会自动重新部署。

## 之后接真实项目

把 `public/mock.js` 换成真实数据来源（fetch 后端 API），
`app.js` 的渲染函数基本不用改。需要更复杂的交互时，
可在此骨架上继续扩展，或迁移到前端框架。
