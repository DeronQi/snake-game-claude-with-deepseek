/* 贪吃蛇 · 游戏主逻辑（无构建、无运行时依赖） */
(function () {
  'use strict';

  window.__SNAKE_VERSION__ = '1';

  const AI = window.SnakeAI;
  if (!AI) {
    throw new Error('SnakeAI 未加载');
  }

  const COLS = AI.COLS;
  const ROWS = AI.ROWS;
  const CELLS = AI.N;

  const DIFFICULTIES = {
    easy: { label: '轻松', base: 230, min: 150 },
    normal: { label: '标准', base: 150, min: 78 },
    hard: { label: '困难', base: 105, min: 58 },
    insane: { label: '狂野', base: 70, min: 38 }
  };
  const DIFFICULTY_ORDER = ['easy', 'normal', 'hard', 'insane'];
  const AI_SPEEDS = [1, 4, 16, 64, 'MAX'];
  const MAX_STEPS_PER_FRAME = 18;
  const STORAGE = {
    best: 'snake.bestScore',
    difficulty: 'snake.difficulty',
    muted: 'snake.muted',
    aiSpeed: 'snake.aiSpeed'
  };

  const dom = {
    app: document.getElementById('app'),
    stageWrap: document.getElementById('stageWrap'),
    boardFrame: document.getElementById('boardFrame'),
    canvas: document.getElementById('board'),
    overlay: document.getElementById('overlay'),
    overlayCard: document.querySelector('.overlay-card'),
    panels: {
      start: document.getElementById('startPanel'),
      pause: document.getElementById('pausePanel'),
      over: document.getElementById('overPanel'),
      win: document.getElementById('winPanel')
    },
    score: document.getElementById('scoreValue'),
    best: document.getElementById('bestValue'),
    speed: document.getElementById('speedValue'),
    difficultyGroup: document.getElementById('difficultyGroup'),
    difficultyButtons: Array.from(document.querySelectorAll('[data-difficulty]')),
    startBtn: document.getElementById('startBtn'),
    aiDemoBtn: document.getElementById('aiDemoBtn'),
    resumeBtn: document.getElementById('resumeBtn'),
    restartFromPauseBtn: document.getElementById('restartFromPauseBtn'),
    restartBtn: document.getElementById('restartBtn'),
    aiDemoOverBtn: document.getElementById('aiDemoOverBtn'),
    winRestartBtn: document.getElementById('winRestartBtn'),
    winAiBtn: document.getElementById('winAiBtn'),
    pauseBtn: document.getElementById('pauseBtn'),
    aiToggle: document.getElementById('aiToggle'),
    soundToggle: document.getElementById('soundToggle'),
    fullscreenToggle: document.getElementById('fullscreenToggle'),
    aiBar: document.getElementById('aiBar'),
    aiStats: document.getElementById('aiStats'),
    aiSpeedBtn: document.getElementById('aiSpeedBtn'),
    overScore: document.getElementById('overScore'),
    overBest: document.getElementById('overBest'),
    pauseLede: document.getElementById('pauseLede'),
    winText: document.getElementById('winText'),
    dpad: document.getElementById('dpad'),
    dpadButtons: Array.from(document.querySelectorAll('.dpad-btn'))
  };

  const ctx = dom.canvas.getContext('2d', { alpha: false });
  const reduceMotionQuery = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

  function readStorage(key, fallback) {
    try {
      const value = window.localStorage.getItem(key);
      return value === null ? fallback : value;
    } catch (error) {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch (error) {
      /* 隐私模式或存储已满时仍允许本局继续运行 */
    }
  }

  function loadBest() {
    const parsed = Number.parseInt(readStorage(STORAGE.best, '0'), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, CELLS - 3) : 0;
  }

  function loadDifficulty() {
    const stored = readStorage(STORAGE.difficulty, 'normal');
    return Object.prototype.hasOwnProperty.call(DIFFICULTIES, stored) ? stored : 'normal';
  }

  function loadMuted() {
    return readStorage(STORAGE.muted, 'false') === 'true';
  }

  function loadAISpeedIndex() {
    const parsed = Number.parseInt(readStorage(STORAGE.aiSpeed, '2'), 10);
    return Number.isInteger(parsed) && parsed >= 0 && parsed < AI_SPEEDS.length ? parsed : 2;
  }

  function initialSnake() {
    // 头在 (2,0)，身体向左，第一帧向右出发。
    return [
      { x: 2, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 0 }
    ];
  }

  function randomFood(snake) {
    const occupied = new Uint8Array(CELLS);
    for (let i = 0; i < snake.length; i += 1) {
      occupied[snake[i].y * COLS + snake[i].x] = 1;
    }
    const free = [];
    for (let i = 0; i < CELLS; i += 1) {
      if (!occupied[i]) free.push(i);
    }
    if (!free.length) return null;
    const chosen = free[Math.floor(Math.random() * free.length)];
    return { x: chosen % COLS, y: Math.floor(chosen / COLS) };
  }

  const state = {
    snake: initialSnake(),
    food: null,
    dir: { x: 1, y: 0 },
    queue: [],
    score: 0,
    best: loadBest(),
    level: 1,
    steps: 0,
    difficulty: loadDifficulty(),
    ai: false,
    aiSpeedIndex: loadAISpeedIndex(),
    mode: 'start',
    muted: loadMuted(),
    deathAt: 0
  };

  state.food = randomFood(state.snake);

  let boardSize = 0;
  let devicePixelRatioCapped = 1;
  let accumulator = 0;
  let previousFrame = 0;
  let rafId = 0;
  let lastAIFruitFx = 0;
  let lastDpadPointerAt = 0;
  let deathClassTimer = 0;
  let audioContext = null;
  let reloadingForServiceWorker = false;
  let dragPointer = null;

  /* ------------------------------------------------------------------ *
   * 状态与界面
   * ------------------------------------------------------------------ */

  function levelForScore(score) {
    return Math.min(10, Math.floor(score / 4) + 1);
  }

  function stepDuration() {
    const config = DIFFICULTIES[state.difficulty] || DIFFICULTIES.normal;
    const levelProgress = (state.level - 1) / 9;
    return Math.round(config.base + (config.min - config.base) * levelProgress);
  }

  function updateTitle() {
    const base = '贪吃蛇';
    if (state.mode === 'playing') {
      document.title = `得分 ${state.score} · ${base}`;
    } else if (state.mode === 'paused') {
      document.title = `已暂停 · 得分 ${state.score} · ${base}`;
    } else if (state.mode === 'won') {
      document.title = `通关 · 得分 ${state.score} · ${base}`;
    } else if (state.mode === 'over') {
      document.title = `结束 · 得分 ${state.score} · ${base}`;
    } else {
      document.title = base;
    }
  }

  function updateHUD() {
    dom.score.textContent = String(state.score);
    dom.best.textContent = String(state.best);
    dom.speed.textContent = `Lv.${state.level} · ${stepDuration()}ms`;
    dom.speed.setAttribute('aria-label', `等级 ${state.level}，每步 ${stepDuration()} 毫秒`);
  }

  function updateDifficultyUI() {
    for (let i = 0; i < dom.difficultyButtons.length; i += 1) {
      const button = dom.difficultyButtons[i];
      const active = button.dataset.difficulty === state.difficulty;
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function updateAIControls() {
    const active = state.ai;
    dom.aiToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    dom.aiToggle.setAttribute('aria-label', active ? '关闭 AI 演示，切回手动' : '开启 AI 演示');
    dom.aiToggle.title = active ? '关闭 AI 演示' : 'AI 演示';

    const showBar = active && (state.mode === 'playing' || state.mode === 'paused');
    dom.aiBar.hidden = !showBar;

    const speed = AI_SPEEDS[state.aiSpeedIndex];
    dom.aiSpeedBtn.textContent = speed === 'MAX' ? 'MAX' : `×${speed}`;
    dom.aiSpeedBtn.setAttribute(
      'aria-label',
      `AI 演示速度，当前 ${speed === 'MAX' ? 'MAX' : speed + ' 倍'}，点击切换`
    );
  }

  function updateControlButtons() {
    const canPause = state.mode === 'playing' || state.mode === 'paused';
    dom.pauseBtn.disabled = !canPause;
    dom.pauseBtn.setAttribute('aria-pressed', state.mode === 'paused' ? 'true' : 'false');
    dom.pauseBtn.setAttribute('aria-label', state.mode === 'paused' ? '继续' : '暂停');
    dom.pauseBtn.textContent = state.mode === 'paused' ? '▶' : '❚❚';

    const center = dom.dpad.querySelector('.center');
    if (center) {
      const paused = state.mode === 'paused';
      center.textContent = paused ? '▶' : '❚❚';
      center.setAttribute('aria-label', paused ? '继续' : '暂停');
    }
    updateAIControls();
  }

  function syncUI() {
    updateHUD();
    updateDifficultyUI();
    updateControlButtons();
    updateTitle();
  }

  function showPanel(name, focusPrimary) {
    const mapping = { start: 'startTitle', pause: 'pauseTitle', over: 'overTitle', win: 'winTitle' };
    Object.keys(dom.panels).forEach((key) => {
      dom.panels[key].hidden = key !== name;
    });
    dom.overlay.classList.add('is-visible');
    dom.overlay.setAttribute('aria-hidden', 'false');
    if (mapping[name]) dom.overlay.setAttribute('aria-labelledby', mapping[name]);

    if (focusPrimary) {
      const focusTargets = {
        start: dom.startBtn,
        pause: dom.resumeBtn,
        over: dom.restartBtn,
        win: dom.winRestartBtn
      };
      const target = focusTargets[name];
      if (target) {
        window.setTimeout(() => {
          if (dom.overlay.classList.contains('is-visible')) {
            try {
              target.focus({ preventScroll: true });
            } catch (error) {
              target.focus();
            }
          }
        }, 30);
      }
    }
  }

  function hideOverlay() {
    dom.overlay.classList.remove('is-visible');
    dom.overlay.setAttribute('aria-hidden', 'true');
  }

  function resetRound(aiMode) {
    state.snake = initialSnake();
    state.dir = { x: 1, y: 0 };
    state.queue = [];
    state.score = 0;
    state.level = 1;
    state.steps = 0;
    state.ai = Boolean(aiMode);
    state.mode = 'playing';
    state.deathAt = 0;
    state.food = randomFood(state.snake);
    accumulator = 0;
    previousFrame = 0;
    lastAIFruitFx = 0;
    dom.boardFrame.classList.remove('is-dead', 'is-won');
    window.clearTimeout(deathClassTimer);
  }

  function beginGame(aiMode) {
    ensureAudio();
    resetRound(aiMode);
    hideOverlay();
    syncUI();
    playSound('start');
    if (dom.canvas && dom.canvas.focus) {
      try {
        dom.canvas.focus({ preventScroll: true });
      } catch (error) {
        dom.canvas.focus();
      }
    }
  }

  function restartCurrentMode() {
    beginGame(state.ai);
  }

  function pauseGame(auto) {
    if (state.mode !== 'playing') return;
    state.mode = 'paused';
    accumulator = 0;
    dom.pauseLede.textContent = auto ? '页面进入后台，已自动暂停。' : '喘口气，节奏还在。';
    showPanel('pause', !auto);
    syncUI();
    render(performance.now());
  }

  function resumeGame() {
    if (state.mode !== 'paused') return;
    state.mode = 'playing';
    accumulator = 0;
    previousFrame = 0;
    hideOverlay();
    syncUI();
    try {
      dom.canvas.focus({ preventScroll: true });
    } catch (error) {
      dom.canvas.focus();
    }
  }

  function togglePause() {
    if (state.mode === 'playing') {
      pauseGame(false);
    } else if (state.mode === 'paused') {
      resumeGame();
    }
  }

  function commitBest() {
    if (state.score <= state.best) return;
    state.best = state.score;
    // 关键：刷新纪录的当下立即写入 localStorage，而不是等游戏结束。
    writeStorage(STORAGE.best, state.best);
    dom.best.textContent = String(state.best);
  }

  function finishGameAsDead() {
    state.mode = 'over';
    state.queue = [];
    state.deathAt = performance.now();
    dom.overScore.textContent = String(state.score);
    dom.overBest.textContent = state.score >= state.best && state.score > 0
      ? `新纪录 · 最高分 ${state.best}`
      : `最高分 ${state.best}`;
    showPanel('over', true);
    syncUI();

    playSound('die');
    vibrate([70, 35, 120]);

    if (!(reduceMotionQuery && reduceMotionQuery.matches)) {
      dom.boardFrame.classList.remove('is-won');
      dom.boardFrame.classList.add('is-dead');
      window.clearTimeout(deathClassTimer);
      deathClassTimer = window.setTimeout(() => {
        dom.boardFrame.classList.remove('is-dead');
      }, 460);
    }
  }

  function finishGameAsWon() {
    state.mode = 'won';
    state.food = null;
    state.level = 10;
    dom.winText.textContent = state.ai
      ? 'AI 通关！AI 用 397 个果实填满了整个棋盘'
      : '你通关了！你用 397 个果实填满了整个棋盘。';
    showPanel('win', true);
    syncUI();
    dom.boardFrame.classList.remove('is-dead');
    dom.boardFrame.classList.add('is-won');
    playSound('win');
    vibrate([30, 40, 30, 40, 90]);
  }

  function die() {
    if (state.mode !== 'playing') return;
    finishGameAsDead();
  }

  /* ------------------------------------------------------------------ *
   * 移动与成长
   * ------------------------------------------------------------------ */

  function enqueueDirection(dx, dy, fromAI) {
    if (!fromAI && state.ai) return false;
    if (state.mode !== 'playing') return false;
    if (dx === 0 && dy === 0) return false;

    const reference = state.queue.length ? state.queue[state.queue.length - 1] : state.dir;
    if (reference.x === dx && reference.y === dy) return false;
    if (reference.x === -dx && reference.y === -dy) return false;
    if (state.queue.length >= 2) return false;

    state.queue.push({ x: dx, y: dy });
    return true;
  }

  function directionFromKey(dx, dy) {
    ensureAudio();
    enqueueDirection(dx, dy, false);
  }

  function eatFeedback(now) {
    if (!state.ai) {
      playSound('eat');
      vibrate(11);
      return;
    }
    // MAX 速度下节流，防止 400 次音效叠成噪音；演示模式不震动。
    if (now - lastAIFruitFx > 65) {
      lastAIFruitFx = now;
      playSound('eat');
    }
  }

  function performStep(now) {
    if (state.mode !== 'playing') return;

    let moveX;
    let moveY;

    if (state.ai) {
      const move = AI.nextMove(state.snake, state.food, { mode: 'strategy' });
      if (!move) {
        die();
        return;
      }
      moveX = move.dx;
      moveY = move.dy;
      state.dir = { x: moveX, y: moveY };
      state.steps += 1;
    } else {
      if (state.queue.length) {
        state.dir = state.queue.shift();
      }
      moveX = state.dir.x;
      moveY = state.dir.y;
      state.steps += 1;
    }

    const head = state.snake[0];
    const nextX = head.x + moveX;
    const nextY = head.y + moveY;

    if (nextX < 0 || nextX >= COLS || nextY < 0 || nextY >= ROWS) {
      die();
      return;
    }

    const eating = state.food && nextX === state.food.x && nextY === state.food.y;
    const collisionLimit = eating ? state.snake.length : state.snake.length - 1;
    for (let i = 0; i < collisionLimit; i += 1) {
      if (state.snake[i].x === nextX && state.snake[i].y === nextY) {
        die();
        return;
      }
    }

    state.snake.unshift({ x: nextX, y: nextY });

    if (eating) {
      if (!state.ai) {
        accumulator = 0;
      }
      state.score += 1;
      state.level = levelForScore(state.score);
      commitBest();
      eatFeedback(now);

      if (state.snake.length >= CELLS) {
        updateHUD();
        finishGameAsWon();
        return;
      }

      state.food = randomFood(state.snake);
      updateHUD();
      updateTitle();
    } else {
      state.snake.pop();
    }
  }

  /* ------------------------------------------------------------------ *
   * 游戏循环
   * ------------------------------------------------------------------ */

  function runAISteps(delta) {
    const multiplier = AI_SPEEDS[state.aiSpeedIndex];

    if (multiplier === 'MAX') {
      for (let i = 0; i < MAX_STEPS_PER_FRAME && state.mode === 'playing'; i += 1) {
        performStep(performance.now());
      }
      accumulator = 0;
      return;
    }

    const interval = Math.max(0.25, stepDuration() / multiplier);
    accumulator += delta;
    let guard = 0;
    while (accumulator >= interval && state.mode === 'playing' && guard < 160) {
      accumulator -= interval;
      performStep(performance.now());
      guard += 1;
    }
    if (guard >= 160) accumulator = 0;
  }

  function runPlayerSteps(delta) {
    const interval = stepDuration();
    accumulator += delta;
    if (accumulator >= interval) {
      accumulator -= interval;
      performStep(performance.now());
      if (accumulator > interval * 2.5) accumulator = 0;
    }
  }

  function loop(timestamp) {
    rafId = window.requestAnimationFrame(loop);

    if (!previousFrame) previousFrame = timestamp;
    const delta = Math.max(0, Math.min(120, timestamp - previousFrame));
    previousFrame = timestamp;

    if (state.mode === 'playing') {
      if (state.ai) {
        runAISteps(delta);
      } else {
        runPlayerSteps(delta);
      }
    }

    if (state.ai) {
      dom.aiStats.textContent = `${state.steps} 步`;
    }

    render(timestamp);
  }

  /* ------------------------------------------------------------------ *
   * Canvas 渲染
   * ------------------------------------------------------------------ */

  function roundedRect(context, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function drawBoardBackground(size) {
    const gradient = ctx.createLinearGradient(0, 0, size, size);
    gradient.addColorStop(0, '#07141f');
    gradient.addColorStop(0.55, '#050e17');
    gradient.addColorStop(1, '#030910');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);

    const vignette = ctx.createRadialGradient(
      size * 0.5, size * 0.42, size * 0.08,
      size * 0.5, size * 0.5, size * 0.72
    );
    vignette.addColorStop(0, 'rgba(36, 104, 74, 0.1)');
    vignette.addColorStop(0.62, 'rgba(7, 20, 31, 0.02)');
    vignette.addColorStop(1, 'rgba(0, 0, 0, 0.36)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, size, size);

    if (state.food) {
      const foodGlow = ctx.createRadialGradient(
        (state.food.x + 0.5) * (size / COLS),
        (state.food.y + 0.5) * (size / ROWS),
        0,
        (state.food.x + 0.5) * (size / COLS),
        (state.food.y + 0.5) * (size / ROWS),
        size * 0.16
      );
      foodGlow.addColorStop(0, 'rgba(255, 115, 75, 0.15)');
      foodGlow.addColorStop(1, 'rgba(255, 115, 75, 0)');
      ctx.fillStyle = foodGlow;
      ctx.fillRect(0, 0, size, size);
    }

    const cell = size / COLS;
    ctx.lineWidth = Math.max(0.5, Math.min(1, size / 680));
    ctx.strokeStyle = 'rgba(128, 196, 158, 0.065)';
    ctx.beginPath();
    for (let i = 1; i < COLS; i += 1) {
      const offset = i * cell;
      ctx.moveTo(offset, 0);
      ctx.lineTo(offset, size);
      ctx.moveTo(0, offset);
      ctx.lineTo(size, offset);
    }
    ctx.stroke();
  }

  function drawFood(size, timestamp) {
    if (!state.food) return;
    const cell = size / COLS;
    const pulse = reduceMotionQuery && reduceMotionQuery.matches
      ? 1
      : 1 + Math.sin(timestamp / 215) * 0.075;
    const radius = cell * 0.29 * pulse;
    const cx = (state.food.x + 0.5) * cell;
    const cy = (state.food.y + 0.52) * cell;

    ctx.save();
    ctx.shadowColor = 'rgba(255, 98, 67, 0.9)';
    ctx.shadowBlur = cell * 0.85 * pulse;
    const fruit = ctx.createRadialGradient(
      cx - radius * 0.3, cy - radius * 0.35, radius * 0.08,
      cx, cy, radius * 1.15
    );
    fruit.addColorStop(0, '#ffd4b8');
    fruit.addColorStop(0.3, '#ff996c');
    fruit.addColorStop(0.72, '#ff6b46');
    fruit.addColorStop(1, '#dd3f31');
    ctx.fillStyle = fruit;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(255, 238, 207, 0.68)';
    ctx.beginPath();
    ctx.arc(cx - radius * 0.3, cy - radius * 0.34, radius * 0.18, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#6dffa6';
    ctx.beginPath();
    ctx.ellipse(
      cx + radius * 0.18,
      cy - radius * 0.95,
      radius * 0.36,
      radius * 0.17,
      -0.55,
      0,
      Math.PI * 2
    );
    ctx.fill();
    ctx.restore();
  }

  function drawSnake(size) {
    const cell = size / COLS;
    const length = state.snake.length;
    if (!length) return;

    for (let i = length - 1; i >= 0; i -= 1) {
      const segment = state.snake[i];
      const x = segment.x * cell;
      const y = segment.y * cell;
      const isHead = i === 0;
      const progress = length > 1 ? i / (length - 1) : 0;
      const inset = isHead ? cell * 0.075 : cell * 0.105;
      const radius = isHead ? cell * 0.29 : cell * 0.25;
      const width = cell - inset * 2;

      ctx.save();
      if (isHead) {
        ctx.shadowColor = 'rgba(92, 255, 220, 0.78)';
        ctx.shadowBlur = cell * 0.62;
        ctx.fillStyle = '#6cf7ff';
      } else {
        const lightness = 20 + (1 - progress) * 27;
        const saturation = 57 + (1 - progress) * 17;
        ctx.fillStyle = `hsl(${150 - (1 - progress) * 8} ${saturation}% ${lightness}%)`;
        ctx.shadowColor = 'rgba(38, 220, 128, 0.17)';
        ctx.shadowBlur = cell * 0.18;
      }

      roundedRect(ctx, x + inset, y + inset, width, width, radius);
      ctx.fill();

      if (!isHead) {
        ctx.shadowBlur = 0;
        ctx.strokeStyle = 'rgba(196, 255, 218, 0.08)';
        ctx.lineWidth = Math.max(0.5, cell * 0.018);
        ctx.stroke();
      }
      ctx.restore();
    }

    const head = state.snake[0];
    const headX = (head.x + 0.5) * cell;
    const headY = (head.y + 0.5) * cell;
    const dir = state.dir || { x: 1, y: 0 };
    const perpendicular = { x: -dir.y, y: dir.x };
    const eyeOffsetForward = cell * 0.12;
    const eyeOffsetSide = cell * 0.18;
    const eyeRadius = Math.max(1.2, cell * 0.065);
    const eyeBaseX = headX + dir.x * eyeOffsetForward;
    const eyeBaseY = headY + dir.y * eyeOffsetForward;

    ctx.fillStyle = 'rgba(3, 18, 13, 0.9)';
    for (const sign of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(
        eyeBaseX + perpendicular.x * eyeOffsetSide * sign,
        eyeBaseY + perpendicular.y * eyeOffsetSide * sign,
        eyeRadius,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }

    if (state.snake.length > 1) {
      const tail = state.snake[state.snake.length - 1];
      const tailX = (tail.x + 0.5) * cell;
      const tailY = (tail.y + 0.5) * cell;
      ctx.strokeStyle = 'rgba(86, 245, 157, 0.18)';
      ctx.lineWidth = Math.max(1, cell * 0.07);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(tailX, tailY);
      ctx.lineTo(tailX, tailY);
      ctx.stroke();
    }
  }

  function render(timestamp) {
    if (!ctx || boardSize <= 0) return;
    const size = boardSize;
    ctx.setTransform(devicePixelRatioCapped, 0, 0, devicePixelRatioCapped, 0, 0);
    ctx.clearRect(0, 0, size, size);

    drawBoardBackground(size);
    drawFood(size, timestamp || 0);
    drawSnake(size);

    if (state.mode === 'over' && state.deathAt) {
      const elapsed = (timestamp || performance.now()) - state.deathAt;
      const alpha = Math.max(0, 0.5 * (1 - elapsed / 420));
      if (alpha > 0) {
        ctx.fillStyle = `rgba(255, 43, 67, ${alpha})`;
        ctx.fillRect(0, 0, size, size);
      }
    }

    const edge = ctx.createLinearGradient(0, 0, 0, size);
    edge.addColorStop(0, 'rgba(255, 255, 255, 0.035)');
    edge.addColorStop(0.12, 'rgba(255, 255, 255, 0)');
    edge.addColorStop(0.9, 'rgba(0, 0, 0, 0)');
    edge.addColorStop(1, 'rgba(0, 0, 0, 0.22)');
    ctx.fillStyle = edge;
    ctx.fillRect(0, 0, size, size);
  }

  /* ------------------------------------------------------------------ *
   * 尺寸与高清渲染
   * ------------------------------------------------------------------ */

  function resizeBoard() {
    const availableWidth = dom.stageWrap.clientWidth;
    const availableHeight = dom.stageWrap.clientHeight;
    if (availableWidth < 2 || availableHeight < 2) return;

    const size = Math.max(140, Math.floor(Math.min(availableWidth, availableHeight)));
    if (size <= 0) return;

    dom.boardFrame.style.width = `${size}px`;
    dom.boardFrame.style.height = `${size}px`;

    window.requestAnimationFrame(() => {
      const cssSize = Math.max(1, dom.boardFrame.clientWidth);
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const pixelSize = Math.round(cssSize * dpr);

      if (dom.canvas.width !== pixelSize || dom.canvas.height !== pixelSize) {
        dom.canvas.width = pixelSize;
        dom.canvas.height = pixelSize;
      }
      boardSize = cssSize;
      devicePixelRatioCapped = dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      render(performance.now());
    });
  }

  /* ------------------------------------------------------------------ *
   * 音频与触感
   * ------------------------------------------------------------------ */

  function ensureAudio() {
    if (state.muted) return;
    if (!audioContext) {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return;
      try {
        audioContext = new AudioCtor();
      } catch (error) {
        return;
      }
    }
    if (audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  }

  function tone(frequency, duration, options) {
    if (!audioContext || state.muted) return;
    const opts = options || {};
    const now = audioContext.currentTime + (opts.delay || 0);
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    oscillator.type = opts.type || 'sine';
    oscillator.frequency.setValueAtTime(Math.max(20, frequency), now);
    if (opts.endFrequency) {
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, opts.endFrequency), now + duration);
    }
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, opts.volume || 0.05), now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(audioContext.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.025);
  }

  function playSound(name) {
    if (state.muted) return;
    ensureAudio();
    if (!audioContext) return;

    if (name === 'eat') {
      tone(690, 0.075, { type: 'triangle', volume: 0.035, endFrequency: 980 });
      tone(1380, 0.045, { type: 'sine', volume: 0.012, delay: 0.018 });
    } else if (name === 'start') {
      tone(392, 0.09, { type: 'sine', volume: 0.035 });
      tone(587, 0.12, { type: 'sine', volume: 0.03, delay: 0.075 });
    } else if (name === 'die') {
      tone(190, 0.32, { type: 'sawtooth', volume: 0.04, endFrequency: 55 });
      tone(96, 0.38, { type: 'square', volume: 0.018, delay: 0.03, endFrequency: 42 });
    } else if (name === 'win') {
      [523, 659, 784, 1047].forEach((frequency, index) => {
        tone(frequency, 0.16, { type: 'triangle', volume: 0.036, delay: index * 0.09 });
      });
    }
  }

  function vibrate(pattern) {
    if (typeof navigator.vibrate === 'function') {
      try {
        navigator.vibrate(pattern);
      } catch (error) {
        /* 某些浏览器在无用户手势时会拒绝震动 */
      }
    }
  }

  function toggleMuted() {
    state.muted = !state.muted;
    writeStorage(STORAGE.muted, state.muted);
    dom.soundToggle.textContent = state.muted ? '🔇' : '🔊';
    dom.soundToggle.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
    dom.soundToggle.setAttribute('aria-label', state.muted ? '开启声音' : '静音');
    dom.soundToggle.title = state.muted ? '开启声音' : '声音';
    if (!state.muted) {
      ensureAudio();
      playSound('start');
    }
  }

  /* ------------------------------------------------------------------ *
   * 事件
   * ------------------------------------------------------------------ */

  function setDifficulty(value, persist) {
    if (!Object.prototype.hasOwnProperty.call(DIFFICULTIES, value)) return;
    state.difficulty = value;
    if (persist) writeStorage(STORAGE.difficulty, value);
    updateDifficultyUI();
    if (state.mode === 'start' || state.mode === 'paused' || state.mode === 'playing') {
      updateHUD();
    }
  }

  function cycleAISpeed() {
    state.aiSpeedIndex = (state.aiSpeedIndex + 1) % AI_SPEEDS.length;
    writeStorage(STORAGE.aiSpeed, state.aiSpeedIndex);
    updateAIControls();
  }

  function handleAIButton() {
    if (state.mode === 'start' || state.mode === 'over' || state.mode === 'won') {
      beginGame(true);
      return;
    }
    state.ai = !state.ai;
    state.queue = [];
    if (state.ai) state.dir = state.dir || { x: 1, y: 0 };
    updateAIControls();
  }

  function toggleFullscreen() {
    const root = document.documentElement;
    const canFullscreen = document.fullscreenEnabled || document.webkitFullscreenEnabled;
    if (!canFullscreen) return;

    const active = document.fullscreenElement || document.webkitFullscreenElement;
    try {
      let result;
      if (active) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (!exit) return;
        result = exit.call(document);
      } else {
        const request = root.requestFullscreen || root.webkitRequestFullscreen;
        if (!request) return;
        result = request.call(root);
      }
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (error) {
      /* 全屏失败不打断游戏 */
    }
  }

  function updateFullscreenButton() {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    dom.fullscreenToggle.setAttribute('aria-pressed', active ? 'true' : 'false');
    dom.fullscreenToggle.setAttribute('aria-label', active ? '退出全屏' : '进入全屏');
    dom.fullscreenToggle.title = active ? '退出全屏' : '全屏';
    window.setTimeout(resizeBoard, 80);
  }

  function handleKeydown(event) {
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const key = event.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    const targetTag = event.target && event.target.tagName ? event.target.tagName.toLowerCase() : '';
    const interactive = /^(button|input|select|textarea|a|summary)$/.test(targetTag);

    if (key === 'ArrowUp' || lower === 'w') {
      event.preventDefault();
      directionFromKey(0, -1);
      return;
    }
    if (key === 'ArrowDown' || lower === 's') {
      event.preventDefault();
      directionFromKey(0, 1);
      return;
    }
    if (key === 'ArrowLeft' || lower === 'a') {
      event.preventDefault();
      directionFromKey(-1, 0);
      return;
    }
    if (key === 'ArrowRight' || lower === 'd') {
      event.preventDefault();
      directionFromKey(1, 0);
      return;
    }
    if (key === ' ' || key === 'Spacebar') {
      if (interactive) return;
      event.preventDefault();
      if (!event.repeat) togglePause();
      return;
    }
    if (lower === 'p') {
      event.preventDefault();
      if (!event.repeat) togglePause();
      return;
    }
    if (lower === 'r') {
      event.preventDefault();
      if (!event.repeat) beginGame(state.ai);
      return;
    }
    if (key === 'Enter') {
      if (interactive) return;
      if (state.mode === 'over' || state.mode === 'won') {
        event.preventDefault();
        beginGame(state.ai);
      }
      return;
    }
    if (lower === 'm') {
      event.preventDefault();
      if (!event.repeat) toggleMuted();
    }
  }

  function handleDpadAction(button) {
    ensureAudio();
    const action = button.dataset.action;
    if (action === 'pause') {
      togglePause();
      return;
    }
    const directions = {
      up: [0, -1],
      down: [0, 1],
      left: [-1, 0],
      right: [1, 0]
    };
    const dir = directions[button.dataset.dir];
    if (dir) enqueueDirection(dir[0], dir[1], false);
  }

  function wireDpad() {
    for (let i = 0; i < dom.dpadButtons.length; i += 1) {
      const button = dom.dpadButtons[i];
      button.addEventListener('pointerdown', (event) => {
        event.preventDefault();
        lastDpadPointerAt = Date.now();
        handleDpadAction(button);
      });
      button.addEventListener('click', () => {
        if (Date.now() - lastDpadPointerAt < 450) return;
        handleDpadAction(button);
      });
    }
  }

  function wireDrag() {
    dom.canvas.addEventListener('pointerdown', (event) => {
      ensureAudio();
      if (dom.overlay.classList.contains('is-visible')) return;
      if (state.mode !== 'playing' || state.ai) return;

      dragPointer = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY
      };

      // 关键约束：只有弹层不可见、真正进入游戏时才捕获指针。
      try {
        if (dom.canvas.setPointerCapture) dom.canvas.setPointerCapture(event.pointerId);
      } catch (error) {
        /* 触屏浏览器可能不支持，但 window 级监听仍然工作 */
      }
      event.preventDefault();
    });

    window.addEventListener('pointermove', (event) => {
      if (!dragPointer || event.pointerId !== dragPointer.id) return;
      const dx = event.clientX - dragPointer.x;
      const dy = event.clientY - dragPointer.y;
      const threshold = Math.max(14, boardSize * 0.045);
      if (Math.abs(dx) < threshold && Math.abs(dy) < threshold) return;

      if (Math.abs(dx) >= Math.abs(dy)) {
        enqueueDirection(dx > 0 ? 1 : -1, 0, false);
      } else {
        enqueueDirection(0, dy > 0 ? 1 : -1, false);
      }
      dragPointer.x = event.clientX;
      dragPointer.y = event.clientY;
    }, { passive: true });

    function endDrag(event) {
      if (!dragPointer || (event && event.pointerId !== dragPointer.id)) return;
      try {
        if (dom.canvas.hasPointerCapture && dom.canvas.hasPointerCapture(dragPointer.id)) {
          dom.canvas.releasePointerCapture(dragPointer.id);
        }
      } catch (error) {
        /* no-op */
      }
      dragPointer = null;
    }

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    dom.canvas.addEventListener('touchstart', (event) => {
      if (event.cancelable) event.preventDefault();
    }, { passive: false });
  }

  function wireEvents() {
    dom.startBtn.addEventListener('click', () => beginGame(false));
    dom.aiDemoBtn.addEventListener('click', () => beginGame(true));
    dom.resumeBtn.addEventListener('click', resumeGame);
    dom.restartFromPauseBtn.addEventListener('click', restartCurrentMode);
    dom.restartBtn.addEventListener('click', restartCurrentMode);
    dom.aiDemoOverBtn.addEventListener('click', () => beginGame(true));
    dom.winRestartBtn.addEventListener('click', restartCurrentMode);
    dom.winAiBtn.addEventListener('click', () => beginGame(true));
    dom.pauseBtn.addEventListener('click', togglePause);
    dom.aiToggle.addEventListener('click', handleAIButton);
    dom.soundToggle.addEventListener('click', toggleMuted);
    dom.fullscreenToggle.addEventListener('click', toggleFullscreen);
    dom.aiSpeedBtn.addEventListener('click', cycleAISpeed);

    dom.difficultyGroup.addEventListener('click', (event) => {
      const button = event.target.closest('[data-difficulty]');
      if (!button) return;
      setDifficulty(button.dataset.difficulty, true);
    });

    document.addEventListener('keydown', handleKeydown);
    document.addEventListener('fullscreenchange', updateFullscreenButton);
    document.addEventListener('webkitfullscreenchange', updateFullscreenButton);

    document.addEventListener('visibilitychange', () => {
      if (document.hidden && state.mode === 'playing') pauseGame(true);
    });
    window.addEventListener('blur', () => {
      if (state.mode === 'playing') pauseGame(true);
    });
    window.addEventListener('resize', resizeBoard);
    window.addEventListener('orientationchange', resizeBoard);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', resizeBoard);

    if (reduceMotionQuery) {
      const onChange = () => render(performance.now());
      if (typeof reduceMotionQuery.addEventListener === 'function') {
        reduceMotionQuery.addEventListener('change', onChange);
      } else if (typeof reduceMotionQuery.addListener === 'function') {
        reduceMotionQuery.addListener(onChange);
      }
    }

    wireDpad();
    wireDrag();
  }

  /* ------------------------------------------------------------------ *
   * Service Worker
   * ------------------------------------------------------------------ */

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;

    const hadController = Boolean(navigator.serviceWorker.controller);

    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloadingForServiceWorker) return;
      reloadingForServiceWorker = true;
      // 已有旧 SW 的页面被新 SW 接管后刷新一次，保证用户立即拿到新功能。
      window.location.reload();
    });

    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
        .then((registration) => {
          registration.update().catch(() => {});
        })
        .catch(() => {
          /* file:// 或浏览器禁用 SW 时仍可完整游玩 */
        });
    }, { once: true });
  }

  /* ------------------------------------------------------------------ *
   * 启动
   * ------------------------------------------------------------------ */

  function initialize() {
    const coarsePointer = window.matchMedia
      ? window.matchMedia('(pointer: coarse)').matches
      : false;
    if (coarsePointer || 'ontouchstart' in window) {
      document.body.classList.add('touch-device');
    }

    dom.soundToggle.textContent = state.muted ? '🔇' : '🔊';
    dom.soundToggle.setAttribute('aria-pressed', state.muted ? 'true' : 'false');
    dom.soundToggle.setAttribute('aria-label', state.muted ? '开启声音' : '静音');
    dom.soundToggle.title = state.muted ? '开启声音' : '声音';

    updateDifficultyUI();
    showPanel('start', false);
    syncUI();
    wireEvents();

    if ('ResizeObserver' in window) {
      const observer = new ResizeObserver(resizeBoard);
      observer.observe(dom.stageWrap);
    }

    resizeBoard();
    render(performance.now());
    rafId = window.requestAnimationFrame(loop);
    registerServiceWorker();
  }

  // 暴露只读快照，便于验证脚本检查真实状态；不提供修改游戏状态的方法。
  window.__deepSnake = {
    getState() {
      return {
        mode: state.mode,
        score: state.score,
        best: state.best,
        level: state.level,
        steps: state.steps,
        difficulty: state.difficulty,
        stepMs: stepDuration(),
        ai: state.ai,
        aiSpeed: AI_SPEEDS[state.aiSpeedIndex],
        dir: { x: state.dir.x, y: state.dir.y },
        queue: state.queue.map((turn) => ({ x: turn.x, y: turn.y })),
        snake: state.snake.map((segment) => ({ x: segment.x, y: segment.y })),
        food: state.food ? { x: state.food.x, y: state.food.y } : null,
        hasFocus: document.hasFocus(),
        overlayVisible: dom.overlay.classList.contains('is-visible')
      };
    },
    cycle: {
      valid: AI.verifyCycle(),
      width: COLS,
      height: ROWS
    }
  };

  initialize();
})();
