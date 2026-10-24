# 贪吃蛇 · 20×20

纯原生 HTML / CSS / JavaScript（ES2020）实现的贪吃蛇。无框架、无构建、无运行时依赖，可直接双击 `index.html` 游玩；同时支持 PWA 安装、离线刷新，以及一个**保证填满 400 格**的哈密顿环 AI 演示。

源码仓库：<https://github.com/DeronQi/snake-game-claude-with-deepseek>

## 文件清单

| 文件 | 说明 |
| --- | --- |
| `index.html` | 页面结构、弹层、计分板、触屏方向键 |
| `style.css` | 深色视觉、正方形棋盘布局、响应式/横屏紧凑模式、无障碍 |
| `game.js` | 游戏循环、输入、计分、音效、震动、渲染、PWA 注册 |
| `ai.js` | UMD 哈密顿环 AI（浏览器 `window.SnakeAI`，Node `require`） |
| `manifest.webmanifest` | PWA 清单（192/512/maskable 图标） |
| `sw.js` | 网络优先 + 缓存兜底的 Service Worker |
| `icons/` | 192、512、maskable-192、maskable-512 图标 |
| `tools/simulate-ai.cjs` | 4 难度 × 5 种子的无头完整通关验证 |
| `tools/analyze-ai.cjs` | 基线 / 本策略 / 曼哈顿下界的分阶段分析 |
| `tools/verify.cjs` | Playwright：四视口、像素识别自动游玩、AI 通关、file:// |
| `tools/verify-sw-update.cjs` | Playwright：脏缓存、SW 更新、旧缓存清理、离线刷新 |
| `tools/make_icons.py` | Pillow 图标生成脚本（可重复运行） |
| `LICENSE` | MIT 开源许可证 |
| `CHANGELOG.md` | 版本与验证记录 |
| `package.json` | **仅开发验证**所需的 Playwright 依赖与 npm scripts |
| `.gitignore` | 忽略依赖、本地工具与测试产物 |

> 游戏运行时零依赖。`playwright` 只用于自动化验收，不参与网页加载。

## 立即运行

### 双击体验

直接双击 `index.html` 即可游玩。`file://` 下会跳过 Service Worker 注册，其他功能完整。

### PWA / 手机 / 局域网

PWA 安装与离线缓存需要 HTTPS 或 localhost。仓库根目录执行：

```bash
python -m http.server 8080
```

然后打开 `http://localhost:8080`。Chrome / Edge 地址栏右侧会出现安装按钮；手机浏览器可“添加到主屏幕”。部署到任意静态目录或 GitHub Pages 子路径均可，所有路径均为相对路径。

### GitHub Pages

GitHub 仓库的 **Settings → Pages → Deploy from a branch** 选择 `main` 分支与 `/ (root)` 即可。所有资源均使用相对路径，因此在 `https://<user>.github.io/snake-game-claude-with-deepseek/` 子路径下也能正常安装和离线运行。

### 从源码运行

```bash
git clone https://github.com/DeronQi/snake-game-claude-with-deepseek.git
cd snake-game-claude-with-deepseek
python -m http.server 8080
```

## 操作

| 输入 | 功能 |
| --- | --- |
| `↑ ↓ ← →` / `W A S D` | 转向（最多缓存 2 次，禁止 180°） |
| 空格 / `P` | 暂停 / 继续 |
| `R` | 随时重新开始（最高分保留） |
| `Enter` | 结束或通关后重开 |
| `M` | 静音 / 恢复 |
| 鼠标拖动棋盘 | 按拖动方向转向 |
| 触屏滑动棋盘 | 转向 |
| 屏幕方向键 | 转向，中央键暂停 / 继续 |
| 右上角 🤖 | 开启 / 关闭 AI 演示 |
| 右上角 ⛶ | 全屏 |
| 切后台 / 窗口失焦 | 自动暂停 |

## 规则与难度

- 棋盘 20×20，初始 3 节，蛇头向右。
- 吃一个果实 +1 分并增长；每 4 分提升 1 级（最高 Lv.10）。
- 撞墙或咬到自己结束；蛇身填满 400 格时进入独立通关面板，最终得分 397。
- 最高分在吃到果实的瞬间写入 `localStorage`，不是等到本局结束。
- 难度只改变速度：

| 难度 | 起始 ms/步 | Lv.10 ms/步 |
| --- | ---: | ---: |
| 轻松 | 230 | 150 |
| 标准 | 150 | 78 |
| 困难 | 105 | 58 |
| 狂野 | 70 | 38 |

难度选择会持久化。四档状态、静音、AI 演示速度均会记住。

## AI：为什么能保证填满 400 格

`ai.js` 在模块加载时预计算一条 20×20 哈密顿环：

1. 第 0 列向下；
2. 第 1～19 列在 1～19 行蛇形往返；
3. 第 0 行向左闭合。

环经过每个格子恰好一次。为了适配“蛇头 (2,0) 向右出发”的初始状态，实际 AI 序号使用同一无向环的反向遍历；环的边和覆盖性不变，因此第一步就能自然向右。

优化后的决策流程：

1. 在四个相邻空格中，按 `[是否食物, 沿环到食物剩余步数, 曼哈顿距离, 环步长]` 排序，优先选择沿环距离食物最近的格子；
2. 每个候选都先做通用存活检查：走完后蛇头仍要能通过空格接触自己的尾巴；
3. 吃食物的候选还会检查增长后的可达空域，空位充足时要求至少保留一个蛇长的活动空间，避免钻进封闭走廊；
4. 非环捷径再做**保守前瞻模拟**：蛇头走该捷径后，虚拟蛇继续沿环前进 `蛇长 + 1` 步。前 3 步假设尾巴正常移动，之后假设每步都能吃到食物、尾巴不再移动，以最坏增长情况检查是否自撞；
5. 首选候选失败后，依次尝试环步和其它安全候选；全部失败才选择移动后活动空间最大的方向；
6. 空地 `< 蛇长 × 1.25` 时关闭跳格；吃食物和沿环走 1 步仍允许。若门控后无候选，则忽略门控重算。

哈密顿环始终是完整覆盖的最终兜底：只要回到环步，蛇就能按序访问全部 400 格。安全检查和前瞻让它在大多数追果实过程中可以安全地跳步，因此平均每颗果实从纯绕环的约 100 步降至约 57 步，同时仍能稳定填满棋盘。

实测（同一组 5 个种子、每局 397 果实）：

- 纯绕环平均 39,676 步；优化后平均 **22,651 步**，减少 **42.9%**；
- 四档难度 × 5 种子的 20 局模拟平均 **22,881 步**，全部 397 分；
- 前 25% 阶段从 175.7 步/果实降到 **39.3 步/果实**；
- 中段从 99.6 降到 82.5 步/果实；
- 后 25% 受空间限制，维持 24.2 步/果实；
- 额外做了 **1000 个随机种子**压力验证：1000/1000 填满 400 格，平均 23,012 步，最慢 25,474 步；
- `tools/simulate-ai.cjs` 与 `tools/analyze-ai.cjs` 会输出完整数据和捷径次数；额外压力测试使用 `node tools/simulate-ai.cjs --stress=1000`。

算法思路参考：

- [Perfect Snake Challenge](https://github.com/LPRowe/perfect-snake-challenge)
- [How the Snake AI Works: BFS, Tail Safety & Hamiltonian Cycles](https://lkforge.com/games/snake/blog-how-the-ai-works)

演示模式：

- 右上角 🤖 或三个面板中的「🤖 看 AI 演示」进入；
- 演示时忽略玩家转向输入，暂停 / 继续 / 全屏仍可用；
- 速度按 `×1 → ×4 → ×16 → ×64 → MAX` 循环；
- MAX 每帧批量执行最多 18 步，浏览器中实测约 **20～23 秒**通关；
- AI 成绩同样写入最高分；通关文案为「AI 通关！AI 用 397 个果实填满了整个棋盘」。

## PWA 与更新

- `sw.js` 对所有同源 GET 请求采用网络优先，失败后回落到 Cache Storage；导航请求额外回落到 `index.html`。
- `install` 预缓存页面与静态资源，`activate` 删除所有旧 `snake-*` 缓存并 `clients.claim()`。
- `game.js` 以 `{ updateViaCache: 'none' }` 注册，并主动 `registration.update()`。
- 页面被新的 Service Worker 接管且此前已有控制器时，自动 `location.reload()` 一次。
- 发版时同时修改 `sw.js` 的 `VERSION` 和页面资源版本号（`style.css?v=…`、`ai.js?v=…`、`game.js?v=…`），确保缓存键更新。

## 无障碍与适配

- `aria-label`、`aria-pressed`、对话框标题、可见 `:focus-visible` 焦点。
- `prefers-reduced-motion: reduce` 下关闭果实脉动、死亡抖动与演示指示灯动画（触感震动是独立能力，仍按系统策略执行）。
- 使用 `env(safe-area-inset-*)` 适配刘海屏。
- 棋盘通过 `ResizeObserver` 取容器可用空间的 `min(宽, 高)`，始终正方形完整可见。
- Canvas 使用 `devicePixelRatio`（上限 2.5）高清渲染。
- 320px 宽度、390×844、844×390、1280×820 均无页面滚动条；横屏矮屏隐藏屏幕方向键，改用滑动。

## 验证

安装开发依赖与 Chromium：

```bash
npm install
npx playwright install chromium
```

运行全部验证：

```bash
node tools/simulate-ai.cjs
node tools/analyze-ai.cjs
node tools/verify.cjs
node tools/verify-sw-update.cjs
python tools/make_icons.py

# 可选：1000 个随机种子的完整通关压力验证
node tools/simulate-ai.cjs --stress=1000
```

`tools/verify.cjs` 不只读取内部状态：它从 Canvas 像素聚类识别蛇头、果实和身体占用，再用 BFS 自动寻路，通过键盘 / 屏幕方向键 / 触摸滑动真实游玩；随后断言计分、升级、暂停恢复、R 重开、最高分即时落盘与刷新持久化、标题、布局、控制台错误、AI 浏览器通关及 `file://` 可玩。

`tools/verify-sw-update.cjs` 会向 Cache Storage 注入旧版 `game.js` / `style.css` / `index.html`，刷新后确认没有命中旧缓存；再切换服务器到 build 2，验证新 SW 接管、旧缓存清理和断网刷新。

## 数据与存储键

| localStorage 键 | 内容 |
| --- | --- |
| `snake.bestScore` | 最高分 |
| `snake.difficulty` | `easy` / `normal` / `hard` / `insane` |
| `snake.muted` | `true` / `false` |
| `snake.aiSpeed` | AI 速度索引 0～4 |

清空站点数据即可重置。

## 浏览器支持

面向支持 ES2020、Canvas 2D、ResizeObserver、Pointer Events 的现代浏览器：Chrome / Edge 90+、Safari 15.4+、Firefox 100+。Service Worker、安装与震动能力按特性检测降级，不影响基础游戏。

## 许可证

本项目采用 [MIT License](LICENSE)，Copyright (c) 2026 Deron Qi。
