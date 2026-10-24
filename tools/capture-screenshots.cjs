#!/usr/bin/env node
'use strict';

/**
 * 生成 README 截图：
 *   docs/screenshots/desktop-start.png
 *   docs/screenshots/desktop-ai-gameplay.png
 *   docs/screenshots/desktop-win.png
 *   docs/screenshots/mobile-gameplay.png
 *
 * 运行：npm run screenshots
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const OUTPUT = path.join(ROOT, 'docs', 'screenshots');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png'
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      let relative = decodeURIComponent(request.url.split('?')[0]).replace(/^\/+/, '');
      if (!relative) relative = 'index.html';
      const filePath = path.resolve(ROOT, relative);
      if (!filePath.startsWith(ROOT + path.sep) || !fs.existsSync(filePath)) {
        response.writeHead(404).end('not found');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      response.writeHead(200, {
        'Content-Type': MIME[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      fs.createReadStream(filePath).pipe(response);
    });
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      baseUrl: `http://127.0.0.1:${server.address().port}/`
    }));
  });
}

async function openGame(browser, viewport, mobile) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: mobile,
    hasTouch: mobile,
    locale: 'zh-CN'
  });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => Boolean(window.__deepSnake));
  await page.waitForFunction(() => document.getElementById('board').width > 0);
  await sleep(300);
  return { context, page };
}

async function shot(page, name) {
  await page.evaluate(() => {
    if (document.activeElement && typeof document.activeElement.blur === 'function') {
      document.activeElement.blur();
    }
  });
  await sleep(120);
  const file = path.join(OUTPUT, name);
  await page.screenshot({ path: file, scale: 'css' });
  const size = fs.statSync(file).size;
  console.log(`wrote docs/screenshots/${name} (${Math.round(size / 1024)} KB)`);
}

async function waitForScore(page, score) {
  await page.waitForFunction(
    (target) => window.__deepSnake.getState().score >= target,
    score,
    { timeout: 45000 }
  );
}

let baseUrl = '';

async function main() {
  fs.mkdirSync(OUTPUT, { recursive: true });
  const { server, baseUrl: url } = await startServer();
  baseUrl = url;
  const browser = await chromium.launch({ headless: true });

  try {
    // 桌面：开始界面
    const desktop = await openGame(browser, { width: 1280, height: 820 }, false);
    await shot(desktop.page, 'desktop-start.png');

    // 桌面：AI 演示中
    await desktop.page.click('#aiDemoBtn');
    await desktop.page.waitForFunction(() => window.__deepSnake.getState().mode === 'playing');
    await waitForScore(desktop.page, 30);
    await shot(desktop.page, 'desktop-ai-gameplay.png');

    // 桌面：AI 通关
    for (let i = 0; i < 5; i += 1) {
      const label = (await desktop.page.locator('#aiSpeedBtn').textContent()).trim();
      if (label === 'MAX') break;
      await desktop.page.click('#aiSpeedBtn');
      await sleep(40);
    }
    await desktop.page.waitForFunction(() => window.__deepSnake.getState().mode === 'won', null, {
      timeout: 90000,
      polling: 150
    });
    await sleep(350);
    await shot(desktop.page, 'desktop-win.png');
    await desktop.context.close();

    // 手机竖屏：游玩布局与触屏方向键
    const mobile = await openGame(browser, { width: 390, height: 844 }, true);
    await mobile.page.click('#aiDemoBtn');
    await mobile.page.waitForFunction(() => window.__deepSnake.getState().mode === 'playing');
    await waitForScore(mobile.page, 30);
    await shot(mobile.page, 'mobile-gameplay.png');
    await mobile.context.close();
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  console.error('截图生成失败：', error);
  process.exitCode = 1;
});
