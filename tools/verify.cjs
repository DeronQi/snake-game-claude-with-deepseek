#!/usr/bin/env node
'use strict';

/**
 * Playwright 端到端验收。
 * - 4 种视口：1280×820、390×844、844×390、320×568
 * - 用 Canvas 像素识别蛇头与果实，并用 BFS 自动游玩
 * - 验证计分、升级、暂停/恢复、R 重开、最高分持久化、标题、布局、控制台
 * - AI 演示在浏览器中真实跑满 397 个果实
 * - file:// 直接打开仍可游玩
 *
 * 运行：npm run verify   （首次需 npm install）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const FILE_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

const ENVIRONMENTS = [
  {
    name: '桌面 1280×820',
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 1,
    isMobile: false,
    touch: false,
    input: 'keyboard',
    targetFruit: 5,
    landscape: false,
    fullDifficultyMatrix: true
  },
  {
    name: '手机竖屏 390×844',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    touch: true,
    input: 'dpad',
    targetFruit: 1,
    landscape: false,
    fullDifficultyMatrix: false
  },
  {
    name: '手机横屏 844×390',
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 2,
    isMobile: true,
    touch: true,
    input: 'swipe',
    targetFruit: 1,
    landscape: true,
    fullDifficultyMatrix: false
  },
  {
    name: '小屏 320×568',
    viewport: { width: 320, height: 568 },
    deviceScaleFactor: 2,
    isMobile: true,
    touch: true,
    input: 'dpad',
    targetFruit: 1,
    landscape: false,
    fullDifficultyMatrix: false
  }
];

const EXPECTED_SPEEDS = { easy: 230, normal: 150, hard: 105, insane: 70 };
const KEYS = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight'
};
const DIRECTION_NAMES = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};

let failureCount = 0;
let passCount = 0;
const startedAt = Date.now();

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      try {
        const parsed = new URL(request.url, 'http://127.0.0.1');
        let relative = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
        if (!relative) relative = 'index.html';
        const filePath = path.resolve(ROOT, relative);
        if (!filePath.startsWith(ROOT + path.sep) && filePath !== path.join(ROOT, 'index.html')) {
          response.writeHead(403).end('forbidden');
          return;
        }
        fs.stat(filePath, (error, stat) => {
          if (error || !stat.isFile()) {
            response.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
            return;
          }
          const ext = path.extname(filePath).toLowerCase();
          response.writeHead(200, {
            'Content-Type': MIME[ext] || 'application/octet-stream',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Service-Worker-Allowed': '/'
          });
          fs.createReadStream(filePath).pipe(response);
        });
      } catch (error) {
        response.writeHead(500).end('server error');
      }
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function watchConsole(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      errors.push(`console.error: ${message.text()}`);
    }
  });
  page.on('pageerror', (error) => {
    errors.push(`pageerror: ${error.message}`);
  });
  return errors;
}

async function waitForGame(page) {
  await page.waitForFunction(() => Boolean(window.__deepSnake), null, { timeout: 15000 });
  await page.waitForFunction(() => {
    const canvas = document.getElementById('board');
    return canvas && canvas.width > 0 && document.getElementById('boardFrame').clientWidth > 0;
  }, null, { timeout: 15000 });
  await sleep(120);
}

async function gotoGame(page, url) {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await waitForGame(page);
}

async function readState(page) {
  return page.evaluate(() => window.__deepSnake.getState());
}

/**
 * 在页面中读取 Canvas 像素。蛇头/果实由颜色聚类识别，
 * 蛇身占用图用于 BFS 避障。读取安排在下一帧绘制之后。
 */
async function readFrame(page, pauseAtScore) {
  return page.evaluate((pauseAt) => new Promise((resolve, reject) => {
    requestAnimationFrame(() => {
      try {
        const beforeState = window.__deepSnake.getState();
        const beforeTitle = document.title;
        const canvas = document.getElementById('board');
        const afterState = window.__deepSnake.getState();
        if (afterState.mode === 'over' || afterState.mode === 'won') {
          resolve({
            ended: true,
            state: afterState,
            title: beforeTitle,
            beforeScore: beforeState.score,
            head: null,
            food: null,
            blocked: [],
            pixelSize: { width: canvas.width, height: canvas.height }
          });
          return;
        }
        const context = canvas.getContext('2d', { willReadFrequently: true });
        const width = canvas.width;
        const height = canvas.height;
        const image = context.getImageData(0, 0, width, height).data;
        const cols = 20;
        const rows = 20;
        const cellW = width / cols;
        const cellH = height / rows;
        const offsets = [-0.18, -0.12, -0.06, 0, 0.06, 0.12, 0.18];
        const headVotes = new Array(400).fill(0);
        const foodVotes = new Array(400).fill(0);
        const greenVotes = new Array(400).fill(0);
        const headScores = new Array(400).fill(0);
        const foodScores = new Array(400).fill(0);
        const eyeVotes = new Array(400).fill(0);

        for (let gy = 0; gy < rows; gy += 1) {
          for (let gx = 0; gx < cols; gx += 1) {
            const index = gy * cols + gx;
            const centerX = (gx + 0.5) * cellW;
            const centerY = (gy + 0.5) * cellH;
            for (const oy of offsets) {
              for (const ox of offsets) {
                const px = Math.max(0, Math.min(width - 1, Math.round(centerX + ox * cellW)));
                const py = Math.max(0, Math.min(height - 1, Math.round(centerY + oy * cellH)));
                const offset = (py * width + px) * 4;
                const r = image[offset];
                const g = image[offset + 1];
                const b = image[offset + 2];

                // 蛇头是独有的薄荷青色（高绿 + 高蓝），不会与绿色身体混淆。
                if (g > 215 && b > 185 && r < 185 && g > r + 40) {
                  headVotes[index] += 1;
                }
                if (r > 195 && g > 25 && r > g + 50 && r > b + 40) {
                  foodVotes[index] += 1;
                }
                if (g > 55 && g > r + 18 && g > b + 5) {
                  greenVotes[index] += 1;
                }
                // 小尺寸或抗锯齿下严格阈值可能漏检，用青绿色度评分兜底。
                if (g > 150 && b > 150) {
                  headScores[index] += Math.min(g, b) - r;
                }
                if (r > g && r > b && r > 110) {
                  foodScores[index] += r - Math.max(g, b);
                }
                // 蛇头独有两只深色眼睛；背景是偏蓝暗色（g < b），不会误中。
                if (r < 32 && g < 75 && b < 60 && g > b + 1 && g > r + 3) {
                  eyeVotes[index] += 1;
                }
              }
            }
          }
        }

        function bestIndex(votes) {
          let index = -1;
          let value = 0;
          for (let i = 0; i < votes.length; i += 1) {
            if (votes[i] > value) {
              value = votes[i];
              index = i;
            }
          }
          return { index, value };
        }

        let headVote = bestIndex(headVotes);
        if (headVote.index < 0) headVote = bestIndex(headScores);
        if (headVote.index < 0) headVote = bestIndex(eyeVotes);
        let foodVote = bestIndex(foodVotes);
        if (foodVote.index < 0) foodVote = bestIndex(foodScores);
        if (headVote.index < 0) {
          reject(new Error('Canvas 像素识别不到蛇头'));
          return;
        }
        if (foodVote.index < 0) {
          reject(new Error('Canvas 像素识别不到果实'));
          return;
        }

        const head = { x: headVote.index % cols, y: Math.floor(headVote.index / cols) };
        const food = { x: foodVote.index % cols, y: Math.floor(foodVote.index / cols) };
        const blocked = greenVotes.map((votes) => (votes >= 2 ? 1 : 0));
        blocked[head.y * cols + head.x] = 0;
        blocked[food.y * cols + food.x] = 0;

        if (pauseAt && beforeState.mode === 'playing' && beforeState.score >= pauseAt) {
          // 扫描完成后再暂停，仍在同一个 JS 任务里，游戏不会插进一步。
          document.getElementById('pauseBtn').click();
        }

        resolve({
          head,
          food,
          blocked,
          headVotes: headVote.value,
          foodVotes: foodVote.value,
          state: window.__deepSnake.getState(),
          title: beforeTitle,
          beforeScore: beforeState.score,
          pixelSize: { width, height }
        });
      } catch (error) {
        reject(error);
      }
    });
  }), pauseAtScore);
}

async function readAlignedFrame(page, pauseAtScore) {
  let lastError = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const frame = await readFrame(page, pauseAtScore);
      if (frame.ended) return frame;
      const head = frame.state.snake[0];
      const food = frame.state.food;
      if (head && frame.head.x === head.x && frame.head.y === head.y &&
          food && frame.food.x === food.x && frame.food.y === food.y) {
        return frame;
      }
      lastError = new Error(
        `像素与状态不同步：像素头 ${frame.head.x},${frame.head.y} 状态头 ${head && head.x},${head && head.y}`
      );
    } catch (error) {
      lastError = error;
    }
    await sleep(22);
  }
  throw lastError || new Error('读取棋盘失败');
}

function bfsDistance(start, goal, blocked, cols, rows) {
  if (start === goal) return 0;
  const distance = new Int16Array(cols * rows).fill(-1);
  const queue = [start];
  distance[start] = 0;
  const moves = [
    [1, 0], [-1, 0], [0, 1], [0, -1]
  ];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const x = current % cols;
    const y = Math.floor(current / cols);
    for (const [dx, dy] of moves) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const index = ny * cols + nx;
      if (blocked[index] || distance[index] !== -1) continue;
      distance[index] = distance[current] + 1;
      if (index === goal) return distance[index];
      queue.push(index);
    }
  }
  return -1;
}

function floodArea(start, blocked, cols, rows) {
  const seen = new Uint8Array(cols * rows);
  const queue = [start];
  seen[start] = 1;
  let count = 0;
  const moves = [
    [1, 0], [-1, 0], [0, 1], [0, -1]
  ];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    count += 1;
    const x = current % cols;
    const y = Math.floor(current / cols);
    for (const [dx, dy] of moves) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
      const index = ny * cols + nx;
      if (seen[index] || blocked[index]) continue;
      seen[index] = 1;
      queue.push(index);
    }
  }
  return count;
}

function chooseDirection(frame) {
  const cols = 20;
  const rows = 20;
  const start = frame.head.y * cols + frame.head.x;
  const goal = frame.food.y * cols + frame.food.x;
  const blocked = frame.blocked.slice();
  // 用来判断“下一步是否安全”时，旧蛇头在移动后会变成身体，应视为障碍。
  blocked[start] = 1;
  blocked[goal] = 0;

  const moves = [
    { dx: 1, dy: 0, name: 'right' },
    { dx: -1, dy: 0, name: 'left' },
    { dx: 0, dy: 1, name: 'down' },
    { dx: 0, dy: -1, name: 'up' }
  ];
  const snakeLength = frame.state.snake.length;
  const requiredArea = Math.max(8, snakeLength + 3);
  const candidates = [];

  for (const move of moves) {
    const nx = frame.head.x + move.dx;
    const ny = frame.head.y + move.dy;
    if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue;
    const index = ny * cols + nx;
    if (blocked[index]) continue;
    const distance = bfsDistance(index, goal, blocked, cols, rows);
    const area = floodArea(index, blocked, cols, rows);
    candidates.push({ name: move.name, distance, area });
  }

  if (!candidates.length) throw new Error('自动游玩 BFS：没有安全方向');

  // 先保证移动后仍有足够活动空间，再优先走更短的路径。
  const safe = candidates.filter((candidate) => candidate.area >= requiredArea);
  const pool = safe.length ? safe : candidates;
  pool.sort((a, b) => {
    const aReach = a.distance >= 0 ? 0 : 1;
    const bReach = b.distance >= 0 ? 0 : 1;
    if (aReach !== bReach) return aReach - bReach;
    if (a.distance !== b.distance) {
      if (a.distance < 0) return b.area - a.area;
      if (b.distance < 0) return a.area - b.area;
      return a.distance - b.distance;
    }
    return b.area - a.area;
  });
  return pool[0].name;
}

async function touchSwipe(page, cdp, direction) {
  const box = await page.locator('#board').boundingBox();
  expect(box, '找不到棋盘用于滑动');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const distance = Math.max(34, Math.min(box.width, box.height) * 0.2);
  const vector = DIRECTION_NAMES[direction];
  const endX = cx + vector.x * distance;
  const endY = cy + vector.y * distance;

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: cx, y: cy, radiusX: 6, radiusY: 6, force: 1, id: 1 }]
  });
  for (let i = 1; i <= 4; i += 1) {
    const t = i / 4;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{
        x: cx + (endX - cx) * t,
        y: cy + (endY - cy) * t,
        radiusX: 6,
        radiusY: 6,
        force: 1,
        id: 1
      }]
    });
    await sleep(8);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

async function sendDirection(page, env, cdp, direction) {
  if (env.input === 'keyboard') {
    await page.keyboard.press(KEYS[direction]);
  } else if (env.input === 'dpad') {
    await page.evaluate((dir) => {
      const button = document.querySelector(`.dpad [data-dir="${dir}"]`);
      if (button) button.click();
    }, direction);
  } else {
    await touchSwipe(page, cdp, direction);
  }
}

async function waitForDirection(page, expected) {
  await page.waitForFunction(({ x, y }) => {
    const state = window.__deepSnake.getState();
    return state.dir.x === x && state.dir.y === y;
  }, expected, { timeout: 2500 });
}

async function playWithPixels(page, env, cdp) {
  const deadline = Date.now() + 45000;
  let crossChecked = false;
  let titleChecked = false;
  let cooldown = 0;
  let retries = 0;

  while (Date.now() < deadline) {
    const frame = await readAlignedFrame(page, env.targetFruit);
    const state = frame.state;

    if (frame.ended || state.mode === 'over') {
      // 验收机器人走的是短视 BFS，允许有限重试；产品 AI 使用独立的哈密顿环策略。
      if (retries < 6) {
        retries += 1;
        await page.keyboard.press('r');
        await page.waitForFunction(() => window.__deepSnake.getState().mode === 'playing', null, {
          timeout: 3000
        });
        await sleep(100);
        cooldown = 0;
        continue;
      }
      throw new Error(`自动游玩撞死了（得分 ${state.score}）`);
    }
    if (!crossChecked) {
      expect(frame.head.x === state.snake[0].x && frame.head.y === state.snake[0].y,
        '像素识别的蛇头与游戏状态不一致');
      expect(frame.food.x === state.food.x && frame.food.y === state.food.y,
        '像素识别的果实与游戏状态不一致');
      crossChecked = true;
    }
    if (!titleChecked && frame.beforeScore > 0) {
      expect(frame.title === `得分 ${frame.beforeScore} · 贪吃蛇`,
        `实时标题错误：${frame.title}`);
      titleChecked = true;
    }

    if (state.score >= env.targetFruit) {
      // readFrame 已在同一 JS 任务里同步暂停，这里直接返回暂停后的状态。
      if (state.mode !== 'paused') {
        await page.waitForFunction(() => window.__deepSnake.getState().mode === 'paused', null, {
          timeout: 3000
        });
        return readState(page);
      }
      return state;
    }
    if (state.mode === 'paused') {
      throw new Error('自动游玩期间意外进入暂停');
    }

    const desired = chooseDirection(frame);
    const now = Date.now();
    const directionDiffers = DIRECTION_NAMES[desired].x !== state.dir.x ||
      DIRECTION_NAMES[desired].y !== state.dir.y;

    // 一次只挂一个转向，避免多个缓存转向在高速下执行顺序错乱。
    if (state.queue.length === 0 && directionDiffers && now >= cooldown) {
      await sendDirection(page, env, cdp, desired);
      cooldown = now + Math.max(45, state.stepMs * 0.6);
    }

    await sleep(12);
  }

  throw new Error(`自动游玩超时，未达到 ${env.targetFruit} 分`);
}

async function assertLayout(page, env) {
  const layout = await page.evaluate(() => {
    const frame = document.getElementById('boardFrame').getBoundingClientRect();
    const canvas = document.getElementById('board');
    const canvasRect = canvas.getBoundingClientRect();
    const doc = document.documentElement;
    const body = document.body;
    return {
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      canvas: {
        x: canvasRect.x,
        y: canvasRect.y,
        width: canvasRect.width,
        height: canvasRect.height,
        pixelWidth: canvas.width,
        pixelHeight: canvas.height
      },
      dpr: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      docScrollWidth: doc.scrollWidth,
      docScrollHeight: doc.scrollHeight,
      docClientWidth: doc.clientWidth,
      docClientHeight: doc.clientHeight,
      bodyScrollWidth: body.scrollWidth,
      bodyScrollHeight: body.scrollHeight,
      touchClass: body.classList.contains('touch-device'),
      dpadDisplay: getComputedStyle(document.getElementById('dpad')).display,
      keyboardDisplay: getComputedStyle(document.getElementById('keyboardHint')).display,
      swipeDisplay: getComputedStyle(document.getElementById('swipeHint')).display,
      startVisible: Boolean(document.getElementById('startBtn').offsetParent),
      aiDemoVisible: Boolean(document.getElementById('aiDemoBtn').offsetParent),
      overlayVisible: document.getElementById('overlay').classList.contains('is-visible'),
      title: document.title
    };
  });

  const tolerance = 1.5;
  expect(Math.abs(layout.frame.width - layout.frame.height) <= tolerance,
    `棋盘非正方形：${layout.frame.width}×${layout.frame.height}`);
  expect(layout.frame.width >= 180, `棋盘过小：${layout.frame.width}`);
  expect(layout.frame.x >= -tolerance && layout.frame.y >= -tolerance,
    `棋盘超出左上边界：${layout.frame.x},${layout.frame.y}`);
  expect(layout.frame.x + layout.frame.width <= layout.innerWidth + tolerance,
    `棋盘右侧溢出：${layout.frame.x + layout.frame.width} > ${layout.innerWidth}`);
  expect(layout.frame.y + layout.frame.height <= layout.innerHeight + tolerance,
    `棋盘底部溢出：${layout.frame.y + layout.frame.height} > ${layout.innerHeight}`);
  expect(layout.docScrollWidth <= layout.docClientWidth + 1,
    `页面出现横向滚动：${layout.docScrollWidth} > ${layout.docClientWidth}`);
  expect(layout.docScrollHeight <= layout.docClientHeight + 1,
    `页面出现纵向滚动：${layout.docScrollHeight} > ${layout.docClientHeight}`);
  expect(layout.bodyScrollWidth <= layout.docClientWidth + 1, 'body 横向溢出');

  const expectedPixels = Math.round(layout.canvas.width * Math.min(layout.dpr, 2.5));
  expect(Math.abs(layout.canvas.pixelWidth - expectedPixels) <= 1,
    `Canvas 未按 DPR 高清渲染：${layout.canvas.pixelWidth} ≠ ${expectedPixels}`);
  expect(Math.abs(layout.canvas.pixelWidth - layout.canvas.pixelHeight) <= 1,
    'Canvas 像素尺寸非正方形');

  expect(layout.startVisible, '开始按钮不可见');
  expect(layout.aiDemoVisible, '「看 AI 演示」按钮不可见');
  expect(layout.overlayVisible, '开始弹层未显示');

  if (env.touch) {
    expect(layout.touchClass, '触屏设备未启用 touch-device 样式');
  }
  if (env.touch && !env.landscape) {
    expect(layout.dpadDisplay !== 'none', '竖屏触屏未显示屏幕方向键');
    expect(layout.keyboardDisplay === 'none', '触屏设备仍显示键盘提示');
  }
  if (env.landscape) {
    expect(layout.dpadDisplay === 'none', '横屏矮屏仍显示屏幕方向键');
    expect(layout.swipeDisplay !== 'none', '横屏矮屏未显示滑动提示');
  }
  if (!env.touch) {
    expect(layout.keyboardDisplay !== 'none', '桌面未显示键盘提示');
    expect(layout.dpadDisplay === 'none', '桌面错误显示屏幕方向键');
  }

  return layout;
}

async function setDifficulty(page, value, expectedMs) {
  await page.click(`[data-difficulty="${value}"]`);
  await sleep(40);
  const snapshot = await page.evaluate((key) => ({
    state: window.__deepSnake.getState(),
    pressed: document.querySelector(`[data-difficulty="${key}"]`).getAttribute('aria-pressed'),
    stored: window.localStorage.getItem('snake.difficulty'),
    speedText: document.getElementById('speedValue').textContent
  }), value);

  expect(snapshot.state.difficulty === value, `难度未切到 ${value}`);
  expect(snapshot.pressed === 'true', `${value} 未显示高亮 aria-pressed`);
  expect(snapshot.stored === value, `${value} 难度未持久化`);
  if (expectedMs !== undefined) {
    expect(snapshot.state.stepMs === expectedMs,
      `${value} 速度应为 ${expectedMs}ms，实际 ${snapshot.state.stepMs}ms`);
    expect(snapshot.speedText.includes(`${expectedMs}ms`),
      `${value} 速度文案未更新：${snapshot.speedText}`);
  }
  return snapshot;
}

async function runEnvironment(browser, baseUrl, env) {
  const context = await browser.newContext({
    viewport: env.viewport,
    deviceScaleFactor: env.deviceScaleFactor,
    isMobile: env.isMobile,
    hasTouch: env.touch,
    locale: 'zh-CN'
  });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  const errors = watchConsole(page);
  let localFailure = null;
  let layoutInfo = null;
  let scoreInfo = 0;

  try {
    await gotoGame(page, baseUrl);
    layoutInfo = await assertLayout(page, env);

    const initialFrame = await readAlignedFrame(page);
    expect(initialFrame.state.mode === 'start', '初始模式不是开始界面');
    expect(initialFrame.state.snake.length === 3, '初始蛇长不是 3');
    expect(initialFrame.state.snake[0].x === 2 && initialFrame.state.snake[0].y === 0,
      '初始蛇头不在 (2,0)');
    expect(initialFrame.state.dir.x === 1 && initialFrame.state.dir.y === 0,
      '初始方向不是向右');

    if (env.fullDifficultyMatrix) {
      for (const key of ['easy', 'normal', 'hard', 'insane']) {
        await setDifficulty(page, key, EXPECTED_SPEEDS[key]);
      }
      await setDifficulty(page, 'hard', EXPECTED_SPEEDS.hard);
      await page.reload({ waitUntil: 'load' });
      await waitForGame(page);
      const afterReload = await page.evaluate(() => ({
        active: document.querySelector('[data-difficulty="hard"]').getAttribute('aria-pressed'),
        stored: window.localStorage.getItem('snake.difficulty'),
        state: window.__deepSnake.getState()
      }));
      expect(afterReload.active === 'true', '刷新后难度高亮丢失');
      expect(afterReload.stored === 'hard', '刷新后难度未持久化');
      expect(afterReload.state.difficulty === 'hard', '刷新后难度状态不对');
      await assertLayout(page, env);
    } else {
      await setDifficulty(page, 'hard', EXPECTED_SPEEDS.hard);
    }

    await page.click('#startBtn');
    await page.waitForFunction(() => window.__deepSnake.getState().mode === 'playing', null, {
      timeout: 5000
    });
    const startedState = await readState(page);
    expect(startedState.overlayVisible === false, '开始后弹层没有隐藏');
    expect(startedState.stepMs === 105, `困难难度速度应为 105ms，实际 ${startedState.stepMs}`);
    expect(await page.title() === '得分 0 · 贪吃蛇', '开局标题未同步');

    if (env.input === 'keyboard') {
      const box = await page.locator('#board').boundingBox();
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      await page.mouse.move(cx, cy);
      await page.mouse.down();
      await page.mouse.move(cx, cy + Math.max(48, box.height * 0.18), { steps: 5 });
      await page.mouse.up();
      await waitForDirection(page, { x: 0, y: 1 });
      const beforeUp = await readState(page);
      await page.keyboard.press('ArrowUp');
      await sleep(240);
      const afterUp = await readState(page);
      expect(afterUp.dir.x === 0 && afterUp.dir.y === 1,
        `禁止 180° 掉头失败：${afterUp.dir.x},${afterUp.dir.y}（原方向 ${beforeUp.dir.x},${beforeUp.dir.y}）`);
    } else if (env.input === 'dpad') {
      const downButton = page.locator('.dpad [data-dir="down"]');
      await downButton.tap();
      await waitForDirection(page, { x: 0, y: 1 });
    } else {
      await touchSwipe(page, cdp, 'down');
      await waitForDirection(page, { x: 0, y: 1 });
    }

    // 暂停 / 恢复（先做一次，确保控制路径本身可用）
    if (env.input === 'keyboard') {
      await page.keyboard.press('Space');
    } else if (!env.landscape) {
      await page.locator('.dpad [data-action="pause"]').tap();
    } else {
      await page.click('#pauseBtn');
    }
    await page.waitForFunction(() => window.__deepSnake.getState().mode === 'paused', null, {
      timeout: 3000
    });
    await page.waitForSelector('#pausePanel', { state: 'visible', timeout: 3000 });
    const firstPause = await readState(page);
    expect(firstPause.overlayVisible, '暂停后弹层未显示');
    const firstPauseTitle = `已暂停 · 得分 ${firstPause.score} · 贪吃蛇`;
    expect(await page.title() === firstPauseTitle, `暂停标题错误：${await page.title()}`);

    await page.click('#resumeBtn');
    await page.waitForFunction(() => window.__deepSnake.getState().mode === 'playing', null, {
      timeout: 3000
    });
    await sleep(180);
    const resumedState = await readState(page);
    expect(resumedState.overlayVisible === false, '继续后弹层未隐藏');
    expect(await page.title() === `得分 ${resumedState.score} · 贪吃蛇`, '恢复后标题未同步');

    const finalState = await playWithPixels(page, env, cdp);
    scoreInfo = finalState.score;
    expect(finalState.mode === 'paused', '达标后未处于暂停状态');
    expect(finalState.score >= env.targetFruit, `未达到目标得分 ${env.targetFruit}`);
    expect(finalState.best >= finalState.score, '最高分没有跟随得分');
    expect(finalState.level >= (env.targetFruit >= 5 ? 2 : 1), '升级未生效');
    if (env.targetFruit >= 5) {
      expect(finalState.level === 2, `吃 5 个果实后应为 Lv.2，实际 Lv.${finalState.level}`);
      expect(finalState.stepMs < 105, '升级后速度未提升');
    }
    const displayScore = await page.locator('#scoreValue').textContent();
    expect(Number(displayScore) === finalState.score, '计分板与状态不同步');
    await page.waitForSelector('#pausePanel', { state: 'visible', timeout: 3000 });
    const pausedTitle = `已暂停 · 得分 ${finalState.score} · 贪吃蛇`;
    expect(await page.title() === pausedTitle, `暂停标题错误：${await page.title()}`);

    const storedBest = await page.evaluate(() => Number(window.localStorage.getItem('snake.bestScore')));
    expect(storedBest === finalState.best,
      `最高分未在吃果实瞬间落盘：localStorage=${storedBest}, best=${finalState.best}`);

    // 从暂停状态 R 重开，最高分不丢
    const bestBeforeRestart = finalState.best;
    await page.keyboard.press('r');
    await page.waitForFunction(() => {
      const state = window.__deepSnake.getState();
      return state.mode === 'playing' && state.score === 0;
    }, null, { timeout: 3000 });
    const restarted = await readState(page);
    expect(restarted.best === bestBeforeRestart, 'R 重开丢失最高分');
    expect(await page.evaluate(() => Number(localStorage.getItem('snake.bestScore'))) === bestBeforeRestart,
      'R 重开后 localStorage 最高分丢失');
    expect(await page.title() === '得分 0 · 贪吃蛇', 'R 重开后标题未归零');

    // 刷新后最高分仍在
    await page.reload({ waitUntil: 'load' });
    await waitForGame(page);
    const persisted = await page.evaluate(() => ({
      best: window.__deepSnake.getState().best,
      stored: Number(localStorage.getItem('snake.bestScore')),
      uiBest: document.getElementById('bestValue').textContent,
      activeDifficulty: document.querySelector('[data-difficulty="hard"]').getAttribute('aria-pressed'),
      title: document.title
    }));
    expect(persisted.best === bestBeforeRestart, '刷新后最高分状态丢失');
    expect(persisted.stored === bestBeforeRestart, '刷新后 localStorage 最高分丢失');
    expect(Number(persisted.uiBest) === bestBeforeRestart, '刷新后最高分 UI 丢失');
    expect(persisted.activeDifficulty === 'true', '刷新后难度高亮丢失');
    expect(persisted.title === '贪吃蛇', '刷新后标题未恢复');
  } catch (error) {
    localFailure = error;
    try {
      await page.screenshot({ path: path.join(__dirname, `_verify-fail-${env.name.replace(/[^\w]+/g, '-')}.png`) });
    } catch (screenshotError) {
      /* ignore */
    }
  }

  if (errors.length) {
    const consoleFailure = new Error(`控制台报错：\n${errors.join('\n')}`);
    localFailure = localFailure ? new Error(`${localFailure.message}\n${consoleFailure.message}`) : consoleFailure;
  }

  await context.close();

  if (localFailure) {
    throw new Error(`${env.name}: ${localFailure.message}`);
  }

  console.log(
    `PASS ${env.name.padEnd(18)} 棋盘 ${Math.round(layoutInfo.frame.width)}px 正方形 | ` +
    `得分 ${scoreInfo} | 最高分持久化 | 暂停/恢复/R | 控制台 0 报错`
  );
  return { score: scoreInfo, layout: layoutInfo };
}

async function verifyAI(browser, baseUrl) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 820 },
    deviceScaleFactor: 1
  });
  const page = await context.newPage();
  const errors = watchConsole(page);
  let failure = null;
  let stats = null;

  try {
    await gotoGame(page, baseUrl);
    expect(await page.locator('#aiDemoBtn').isVisible(), '开始面板缺少 AI 演示按钮');
    await page.click('#aiDemoBtn');
    await page.waitForFunction(() => {
      const state = window.__deepSnake.getState();
      return state.mode === 'playing' && state.ai === true;
    }, null, { timeout: 5000 });
    expect(await page.locator('#aiBar').isVisible(), 'AI 演示条未显示');
    expect((await page.locator('#aiBar').textContent()).includes('AI 演示中'), '演示条文案错误');

    for (let i = 0; i < 8; i += 1) {
      const label = (await page.locator('#aiSpeedBtn').textContent()).trim();
      if (label === 'MAX') break;
      await page.click('#aiSpeedBtn');
      await sleep(50);
    }
    expect((await page.locator('#aiSpeedBtn').textContent()).trim() === 'MAX', '未能切到 MAX 演示速度');
    const aiStart = Date.now();
    await page.waitForFunction(() => window.__deepSnake.getState().mode === 'won', null, {
      timeout: 90000,
      polling: 200
    });
    const duration = (Date.now() - aiStart) / 1000;
    const state = await readState(page);
    expect(state.score === 397, `AI 未填满棋盘：得分 ${state.score}`);
    expect(state.snake.length === 400, `AI 蛇长不是 400：${state.snake.length}`);
    expect(state.level === 10, `AI 通关等级不是 10：${state.level}`);
    expect(await page.title() === '通关 · 得分 397 · 贪吃蛇', `通关标题错误：${await page.title()}`);
    expect(await page.locator('#winPanel').isVisible(), '独立通关面板未显示');
    const winText = (await page.locator('#winText').textContent()).trim();
    expect(winText === 'AI 通关！AI 用 397 个果实填满了整个棋盘', `通关文案错误：${winText}`);
    expect(await page.locator('#winAiBtn').isVisible(), '通关面板缺少 AI 演示按钮');
    expect(await page.locator('#winRestartBtn').isVisible(), '通关面板缺少重开按钮');
    expect(await page.evaluate(() => Number(localStorage.getItem('snake.bestScore'))) === 397,
      'AI 通关最高分未持久化');
    stats = { duration, score: state.score, steps: state.steps };
  } catch (error) {
    failure = error;
    try {
      await page.screenshot({ path: path.join(__dirname, '_verify-fail-ai.png') });
    } catch (screenshotError) {
      /* ignore */
    }
  }

  if (errors.length) {
    const consoleFailure = new Error(`控制台报错：\n${errors.join('\n')}`);
    failure = failure ? new Error(`${failure.message}\n${consoleFailure.message}`) : consoleFailure;
  }
  await context.close();
  if (failure) throw new Error(`AI 演示: ${failure.message}`);
  console.log(
    `PASS AI 浏览器通关      得分 ${stats.score} / 397 | ${stats.steps} 步 | ` +
    `MAX 实际 ${stats.duration.toFixed(1)}s | 控制台 0 报错`
  );
  return stats;
}

async function verifyFile() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors = watchConsole(page);
  let failure = null;

  try {
    await gotoGame(page, FILE_URL);
    expect((await page.evaluate(() => window.__SNAKE_VERSION__)) === '1', 'file:// 未加载 game.js');
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundImage);
    expect(background && background !== 'none', 'file:// 未加载 style.css');
    await assertLayout(page, ENVIRONMENTS[0]);
    await page.click('#startBtn');
    await page.waitForFunction(() => window.__deepSnake.getState().mode === 'playing', null, {
      timeout: 5000
    });
    await page.keyboard.press('ArrowDown');
    await waitForDirection(page, { x: 0, y: 1 });
    await sleep(250);
    const state = await readState(page);
    expect(state.mode === 'playing', 'file:// 开局后未运行');
    expect((await page.title()).startsWith('得分 0 · 贪吃蛇'), 'file:// 标题不同步');
    const swSupported = await page.evaluate(() => 'serviceWorker' in navigator);
    expect(swSupported, '当前浏览器不支持 serviceWorker，降级检查无意义');
  } catch (error) {
    failure = error;
  }

  if (errors.length) {
    const consoleFailure = new Error(`控制台报错：\n${errors.join('\n')}`);
    failure = failure ? new Error(`${failure.message}\n${consoleFailure.message}`) : consoleFailure;
  }
  await context.close();
  await browser.close();
  if (failure) throw new Error(`file:// 直接打开: ${failure.message}`);
  console.log('PASS file:// 直接打开    脚本/样式/开始/转向均正常 | 控制台 0 报错');
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('不是有效 PNG');
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

async function verifyPWA(browser, baseUrl) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors = watchConsole(page);
  let failure = null;

  try {
    const manifestResponse = await context.request.get(`${baseUrl}manifest.webmanifest`, {
      failOnStatusCode: true
    });
    expect(manifestResponse.status() === 200, 'manifest 无法访问');
    const manifest = await manifestResponse.json();
    expect(manifest.name && manifest.short_name, 'manifest 缺少 name/short_name');
    expect(manifest.id === './', 'manifest id 不是相对路径');
    expect(manifest.start_url === './' && manifest.scope === './', 'manifest start_url/scope 不是相对路径');
    expect(manifest.display === 'standalone', 'manifest display 不是 standalone');
    expect(manifest.theme_color === '#05080f', 'manifest theme_color 错误');
    expect(manifest.background_color === '#05080f', 'manifest background_color 错误');
    expect(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'manifest 图标不足');
    const sizes = manifest.icons.map((icon) => icon.sizes);
    expect(sizes.includes('192x192') && sizes.includes('512x512'), 'manifest 缺少 192/512 图标');
    expect(manifest.icons.some((icon) => String(icon.purpose).includes('maskable')),
      'manifest 缺少 maskable 图标');

    for (const icon of manifest.icons) {
      const response = await context.request.get(`${baseUrl}${icon.src}`, { failOnStatusCode: true });
      expect(response.status() === 200, `图标无法访问：${icon.src}`);
      const dimensions = pngDimensions(await response.body());
      const [expectedWidth, expectedHeight] = icon.sizes.split('x').map(Number);
      expect(dimensions.width === expectedWidth && dimensions.height === expectedHeight,
        `图标尺寸错误：${icon.src} ${dimensions.width}×${dimensions.height}`);
    }

    await gotoGame(page, baseUrl);
    await page.waitForFunction(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active);
    }, null, { timeout: 15000 });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {
      timeout: 15000
    });
    const cacheInfo = await page.evaluate(async () => ({
      controller: Boolean(navigator.serviceWorker.controller),
      caches: await caches.keys()
    }));
    expect(cacheInfo.controller, 'Service Worker 未接管页面');
    expect(cacheInfo.caches.some((name) => name.startsWith('snake-')), '未创建 snake-* 缓存');
  } catch (error) {
    failure = error;
  }

  if (errors.length) {
    const consoleFailure = new Error(`控制台报错：\n${errors.join('\n')}`);
    failure = failure ? new Error(`${failure.message}\n${consoleFailure.message}`) : consoleFailure;
  }
  await context.close();
  if (failure) throw new Error(`PWA: ${failure.message}`);
  console.log('PASS PWA 资源           manifest/图标/SW 接管/缓存均正常 | 控制台 0 报错');
}

async function runCase(label, fn) {
  try {
    await fn();
    passCount += 1;
    return true;
  } catch (error) {
    failureCount += 1;
    console.error(`FAIL ${label}`);
    console.error(`     ${error.message}`);
    return false;
  }
}

async function main() {
  const { server, port } = await startServer();
  const baseUrl = `http://127.0.0.1:${port}/`;
  const browser = await chromium.launch({ headless: true });
  console.log('贪吃蛇 Playwright 端到端验收');
  console.log(`本地服务: ${baseUrl}`);
  console.log(`浏览器: Chromium ${browser.version()}\n`);

  try {
    for (const env of ENVIRONMENTS) {
      await runCase(env.name, () => runEnvironment(browser, baseUrl, env));
    }
    await runCase('AI 浏览器通关', () => verifyAI(browser, baseUrl));
    await runCase('PWA 资源', () => verifyPWA(browser, baseUrl));
    await runCase('file:// 直接打开', () => verifyFile());
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log(`\n验收汇总: ${passCount} 通过 / ${failureCount} 失败 / 用时 ${elapsed}s`);
  if (failureCount > 0) {
    console.error('验收未通过。');
    process.exitCode = 1;
  } else {
    console.log('全部验收项通过，0 失败。');
  }
}

main().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exitCode = 1;
});
