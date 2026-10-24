#!/usr/bin/env node
'use strict';

/**
 * 无头模拟：使用与网页完全相同的规则和 SnakeAI，
 * 覆盖 4 档难度 × 5 个随机种子，断言每局都吃满 397 个果实（400 格）。
 *
 * 运行：node tools/simulate-ai.cjs
 */
const path = require('path');
const AI = require(path.join(__dirname, '..', 'ai.js'));

const COLS = AI.COLS;
const ROWS = AI.ROWS;
const CELLS = AI.N;
const FRUIT_TARGET = CELLS - 3;

const DIFFICULTIES = {
  easy: { base: 230, min: 150 },
  normal: { base: 150, min: 78 },
  hard: { base: 105, min: 58 },
  insane: { base: 70, min: 38 }
};
const DIFFICULTY_NAMES = ['easy', 'normal', 'hard', 'insane'];
const SEEDS = [1, 2, 3, 4, 5];
const MAX_STEPS = 500000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function initialSnake() {
  return [
    { x: 2, y: 0 },
    { x: 1, y: 0 },
    { x: 0, y: 0 }
  ];
}

function spawnFood(snake, random) {
  const occupied = new Uint8Array(CELLS);
  for (let i = 0; i < snake.length; i += 1) {
    occupied[snake[i].y * COLS + snake[i].x] = 1;
  }
  const free = [];
  for (let i = 0; i < CELLS; i += 1) {
    if (!occupied[i]) free.push(i);
  }
  if (!free.length) return null;
  const index = free[Math.floor(random() * free.length)];
  return { x: index % COLS, y: Math.floor(index / COLS) };
}

function levelForScore(score) {
  return Math.min(10, Math.floor(score / 4) + 1);
}

function stepMs(difficulty, level) {
  const config = DIFFICULTIES[difficulty];
  return Math.round(config.base + (config.min - config.base) * ((level - 1) / 9));
}

function verifyBoard(snake) {
  if (snake.length !== CELLS) return `长度 ${snake.length} ≠ ${CELLS}`;
  const seen = new Uint8Array(CELLS);
  for (const segment of snake) {
    if (segment.x < 0 || segment.x >= COLS || segment.y < 0 || segment.y >= ROWS) {
      return `越界 ${segment.x},${segment.y}`;
    }
    const key = segment.y * COLS + segment.x;
    if (seen[key]) return `重复格 ${segment.x},${segment.y}`;
    seen[key] = 1;
  }
  return null;
}

function simulateGame(difficulty, seed) {
  const difficultySalt = DIFFICULTY_NAMES.indexOf(difficulty) * 104729;
  const random = mulberry32((seed + difficultySalt) >>> 0);
  let snake = initialSnake();
  let food = spawnFood(snake, random);
  let score = 0;
  let level = 1;
  let steps = 0;
  let simulatedMs = 0;
  const started = process.hrtime.bigint();

  while (steps < MAX_STEPS) {
    if (snake.length >= CELLS) break;
    const move = AI.nextMove(snake, food, { mode: 'strategy' });
    if (!move) {
      throw new Error(`AI 无合法走法：difficulty=${difficulty} seed=${seed} len=${snake.length}`);
    }

    const head = snake[0];
    const next = { x: head.x + move.dx, y: head.y + move.dy };
    if (next.x < 0 || next.x >= COLS || next.y < 0 || next.y >= ROWS) {
      throw new Error(`AI 撞墙：${next.x},${next.y}`);
    }

    const eating = Boolean(food && next.x === food.x && next.y === food.y);
    const collisionLimit = eating ? snake.length : snake.length - 1;
    for (let i = 0; i < collisionLimit; i += 1) {
      if (snake[i].x === next.x && snake[i].y === next.y) {
        throw new Error(`AI 咬到自己：${next.x},${next.y}`);
      }
    }

    simulatedMs += stepMs(difficulty, level);
    snake = [next, ...snake];
    steps += 1;

    if (eating) {
      score += 1;
      level = levelForScore(score);
      if (snake.length >= CELLS) {
        food = null;
        break;
      }
      food = spawnFood(snake, random);
      if (!food) throw new Error('棋盘已满但仍未触发通关');
    } else {
      snake.pop();
    }
  }

  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const boardError = verifyBoard(snake);
  if (score !== FRUIT_TARGET) {
    throw new Error(`果实数 ${score} ≠ ${FRUIT_TARGET}（len=${snake.length}, steps=${steps}）`);
  }
  if (boardError) throw new Error(`棋盘校验失败：${boardError}`);

  return {
    difficulty,
    seed,
    score,
    length: snake.length,
    steps,
    simulatedSeconds: simulatedMs / 1000,
    wallMs
  };
}

function runStress(count) {
  console.log(`SnakeAI 压力验证：${count} 个随机种子（normal 难度）`);
  console.log('每局都必须吃满 397 个果实并填满 400 格。\n');
  const started = Date.now();
  let failures = 0;
  let sum = 0;
  let min = Infinity;
  let max = 0;

  for (let seed = 1; seed <= count; seed += 1) {
    try {
      const result = simulateGame('normal', seed);
      sum += result.steps;
      min = Math.min(min, result.steps);
      max = Math.max(max, result.steps);
    } catch (error) {
      failures += 1;
      if (failures <= 5) console.error(`seed ${seed} FAIL: ${error.message}`);
    }
    if (seed % 200 === 0) {
      console.log(`  进度 ${seed}/${count}，失败 ${failures}`);
    }
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  const passed = count - failures;
  console.log(
    `\n结果: ${passed}/${count} 填满 | 平均 ${passed ? (sum / passed).toFixed(0) : '-'} 步 | ` +
    `最少 ${passed ? min : '-'} | 最多 ${passed ? max : '-'} | 用时 ${elapsed}s`
  );
  if (failures > 0) {
    console.error(`压力验证失败：${failures} 局。`);
    process.exitCode = 1;
    return;
  }
  console.log('压力验证全部通过，0 失败。');
}

function main() {
  const stressArg = process.argv.find((argument) => argument.startsWith('--stress'));
  if (stressArg) {
    const parsed = Number.parseInt(stressArg.split('=')[1], 10);
    const count = Number.isInteger(parsed) && parsed > 0 ? parsed : 1000;
    runStress(count);
    return;
  }

  console.log('SnakeAI 无头完整通关验证');
  console.log(`棋盘: ${COLS}×${ROWS} | 难度: ${DIFFICULTY_NAMES.join(', ')} | 种子: ${SEEDS.join(', ')}\n`);
  console.log(
    '难度'.padEnd(10) +
    '种子'.padStart(5) +
    '结果'.padStart(6) +
    '果实'.padStart(6) +
    '蛇长'.padStart(7) +
    '步数'.padStart(9) +
    '模拟耗时'.padStart(12) +
    '实耗ms'.padStart(10)
  );
  console.log('-'.repeat(78));

  let failures = 0;
  let totalSteps = 0;

  for (const difficulty of DIFFICULTY_NAMES) {
    for (const seed of SEEDS) {
      try {
        const result = simulateGame(difficulty, seed);
        totalSteps += result.steps;
        console.log(
          difficulty.padEnd(10) +
          String(seed).padStart(6) +
          'PASS'.padStart(7) +
          String(result.score).padStart(7) +
          String(result.length).padStart(7) +
          String(result.steps).padStart(9) +
          `${result.simulatedSeconds.toFixed(1)}s`.padStart(13) +
          result.wallMs.toFixed(1).padStart(11)
        );
      } catch (error) {
        failures += 1;
        console.error(`${difficulty} seed=${seed} FAIL: ${error.message}`);
      }
    }
  }

  console.log('-'.repeat(78));
  const runs = DIFFICULTY_NAMES.length * SEEDS.length;
  console.log(`总计: ${runs} 局 | 通过: ${runs - failures} | 失败: ${failures} | 平均步数: ${(totalSteps / runs).toFixed(1)}`);
  if (failures > 0) {
    console.error('验证失败。');
    process.exitCode = 1;
    return;
  }
  console.log('全部跑满 400 格 / 397 个果实，0 失败。');
}

main();
