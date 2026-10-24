#!/usr/bin/env node
'use strict';

/**
 * Service Worker / PWA 更新验证：
 * 1. 第一次加载安装 SW 并接管。
 * 2. 向 Cache Storage 塞入旧 game.js / style.css / index.html。
 * 3. 刷新后必须加载新代码（网络优先，不能被旧缓存欺骗）。
 * 4. 切换服务器到 build 2（新 SW 版本）后刷新一次：
 *    - 页面自动拿到 build 2；
 *    - 新 SW 激活并清理旧缓存；
 *    - 断网刷新仍可加载 build 2。
 *
 * 运行：npm run verify:sw
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png'
};

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const serverState = { build: 1 };

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
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          response.writeHead(404).end('not found');
          return;
        }

        let body = fs.readFileSync(filePath);
        if (serverState.build === 2 && relative === 'game.js') {
          body = Buffer.concat([
            body,
            Buffer.from('\n/* build 2 */\nwindow.__SW_TEST_BUILD__ = "2";\n', 'utf8')
          ]);
        }
        if (serverState.build === 2 && relative === 'sw.js') {
          const text = body.toString('utf8');
          if (!text.includes("const VERSION = 'v1';")) {
            response.writeHead(500).end('cannot patch sw.js');
            return;
          }
          body = Buffer.from(text.replace("const VERSION = 'v1';", "const VERSION = 'v2-test';"), 'utf8');
        }

        const ext = path.extname(filePath).toLowerCase();
        response.writeHead(200, {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Content-Length': body.length,
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Service-Worker-Allowed': '/'
        });
        response.end(body);
      } catch (error) {
        response.writeHead(500).end('server error');
      }
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}/`
    }));
  });
}

function watchConsole(page) {
  const errors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  return errors;
}

function isNavigationRace(error) {
  return /Execution context was destroyed|most likely because of a navigation|Cannot find context/i
    .test(error && error.message ? error.message : '');
}

async function evaluateSafe(page, fn, arg) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await page.evaluate(fn, arg);
    } catch (error) {
      lastError = error;
      if (!isNavigationRace(error)) throw error;
      await sleep(400);
    }
  }
  throw lastError;
}

async function waitForGame(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await page.waitForFunction(() => Boolean(window.__deepSnake), null, { timeout: 20000 });
      await page.waitForFunction(() => {
        const canvas = document.getElementById('board');
        return canvas && canvas.width > 0;
      }, null, { timeout: 10000 });
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(400);
    }
  }
}

async function waitForControlled(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await page.waitForFunction(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const registration = await navigator.serviceWorker.ready;
        return Boolean(registration.active && navigator.serviceWorker.controller);
      }, null, { timeout: 20000 });
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      await sleep(400);
    }
  }
}

async function main() {
  const { server, baseUrl } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  const errors = watchConsole(page);
  let failure = null;

  try {
    console.log('Service Worker 更新 / 离线验证');
    console.log(`本地服务: ${baseUrl}\n`);

    await page.goto(baseUrl, { waitUntil: 'load' });
    await waitForGame(page);
    await waitForControlled(page);
    const initial = await page.evaluate(async () => ({
      version: window.__SNAKE_VERSION__,
      controlled: Boolean(navigator.serviceWorker.controller),
      caches: await caches.keys()
    }));
    expect(initial.version === '1', '初始版本标记错误');
    expect(initial.controlled, '首次安装后 SW 未接管页面');
    expect(initial.caches.some((name) => name === 'snake-v1'), '未建立 snake-v1 缓存');
    console.log('PASS 初始安装          SW 已接管，snake-v1 缓存已建立');

    const seeded = await page.evaluate(async () => {
      const origin = location.origin;
      const current = (await caches.keys()).find((name) => name.startsWith('snake-')) || 'snake-v1';
      const cache = await caches.open(current);
      const stale = await caches.open('snake-v0-stale');
      const asResponse = (body, type) => new Response(body, { headers: { 'Content-Type': type } });

      const gameUrl = new URL('game.js?v=1', origin + '/').href;
      const styleUrl = new URL('style.css?v=1', origin + '/').href;
      const indexUrl = new URL('index.html', origin + '/').href;
      const rootUrl = new URL('./', origin + '/').href;

      await Promise.all([
        cache.put(new Request(gameUrl), asResponse('window.__OLD_GAME__=true;', 'text/javascript')),
        cache.put(new Request(styleUrl), asResponse('body{background:rgb(255,0,0)!important}', 'text/css')),
        cache.put(new Request(indexUrl), asResponse('<html><body>OLD CACHED INDEX</body></html>', 'text/html')),
        cache.put(new Request(rootUrl), asResponse('<html><body>OLD CACHED ROOT</body></html>', 'text/html')),
        stale.put(new Request(indexUrl), asResponse('<html><body>STALE OLD CACHE</body></html>', 'text/html'))
      ]);
      return { current, caches: await caches.keys() };
    });
    expect(seeded.caches.includes('snake-v0-stale'), '旧缓存准备失败');
    console.log('PASS 脏缓存准备        已写入旧 game.js / style.css / index.html');

    await page.reload({ waitUntil: 'load' });
    await waitForGame(page);
    const afterStaleReload = await page.evaluate(() => ({
      version: window.__SNAKE_VERSION__,
      oldGame: Boolean(window.__OLD_GAME__),
      hasCanvas: Boolean(document.getElementById('board')),
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      title: document.title,
      text: document.body.innerText.slice(0, 30)
    }));
    expect(afterStaleReload.version === '1' && !afterStaleReload.oldGame,
      '刷新后加载到了缓存里的旧 game.js');
    expect(afterStaleReload.hasCanvas, '刷新后加载到了旧 index.html');
    expect(afterStaleReload.title === '贪吃蛇', '刷新后标题异常');
    expect(afterStaleReload.bodyBackground !== 'rgb(255, 0, 0)', '刷新后加载到了旧 style.css');
    console.log('PASS 脏缓存后刷新      仍加载新 game.js / style.css / index.html');

    serverState.build = 2;
    await page.reload({ waitUntil: 'load' });
    // game.js 检测到新 SW 接管后会自动 location.reload() 一次；等待最终状态。
    await page.waitForFunction(() => window.__SW_TEST_BUILD__ === '2', null, { timeout: 30000 });
    await waitForGame(page);
    await waitForControlled(page);
    await page.waitForFunction(async () => {
      const names = await caches.keys();
      return names.includes('snake-v2-test');
    }, null, { timeout: 20000 });
    // 新 SW 接管后 game.js 会主动 reload 一次；等这次导航彻底落稳。
    await sleep(1200);
    await waitForGame(page);
    await page.waitForFunction(() => window.__SW_TEST_BUILD__ === '2', null, { timeout: 20000 });
    await waitForControlled(page);
    const afterUpdate = await evaluateSafe(page, async () => ({
      build: window.__SW_TEST_BUILD__,
      version: window.__SNAKE_VERSION__,
      caches: await caches.keys(),
      controlled: Boolean(navigator.serviceWorker.controller),
      hasCanvas: Boolean(document.getElementById('board')),
      title: document.title
    }));
    expect(afterUpdate.build === '2', '发版后没有加载到 build 2');
    expect(afterUpdate.hasCanvas && afterUpdate.title === '贪吃蛇', '新版本页面不完整');
    expect(afterUpdate.controlled, '新 SW 未接管');
    expect(afterUpdate.caches.includes('snake-v2-test'), '新版本缓存未建立');
    expect(!afterUpdate.caches.includes('snake-v1'), 'activate 未清理 snake-v1 旧缓存');
    expect(!afterUpdate.caches.includes('snake-v0-stale'), 'activate 未清理手工旧缓存');
    console.log('PASS 版本更新          刷新一次拿到 build 2，旧缓存已清理');

    const cacheEntries = await evaluateSafe(page, async () => {
      const cache = await caches.open('snake-v2-test');
      const requests = await cache.keys();
      return requests.map((request) => new URL(request.url).pathname + new URL(request.url).search);
    });
    expect(cacheEntries.some((entry) => entry.startsWith('/game.js')), '新缓存缺少 game.js');
    expect(cacheEntries.some((entry) => entry.startsWith('/style.css')), '新缓存缺少 style.css');

    await context.setOffline(true);
    await page.reload({ waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__SW_TEST_BUILD__ === '2', null, { timeout: 20000 });
    await waitForGame(page);
    const offline = await page.evaluate(() => ({
      build: window.__SW_TEST_BUILD__,
      version: window.__SNAKE_VERSION__,
      hasCanvas: Boolean(document.getElementById('board')),
      title: document.title,
      controlled: Boolean(navigator.serviceWorker.controller)
    }));
    expect(offline.build === '2', '断网刷新未加载到缓存中的 build 2');
    expect(offline.hasCanvas && offline.title === '贪吃蛇', '断网刷新页面不完整');
    expect(offline.controlled, '断网时 SW 未接管');
    console.log('PASS 断网刷新          build 2 由 Cache Storage 兜底加载');
    await context.setOffline(false);
  } catch (error) {
    failure = error;
    try {
      await page.screenshot({ path: path.join(__dirname, '_verify-fail-sw.png') });
    } catch (screenshotError) {
      /* ignore */
    }
  }

  if (errors.length) {
    const consoleFailure = new Error(`控制台报错：\n${errors.join('\n')}`);
    failure = failure ? new Error(`${failure.message}\n${consoleFailure.message}`) : consoleFailure;
  }

  await context.close();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));

  if (failure) {
    console.error(`\nSW 验证失败: ${failure.message}`);
    process.exitCode = 1;
    return;
  }
  console.log('\nSW / 离线验证全部通过，0 失败。');
}

main().catch((error) => {
  console.error('验证脚本异常：', error);
  process.exitCode = 1;
});
