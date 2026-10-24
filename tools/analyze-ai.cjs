#!/usr/bin/env node
'use strict';

/**
 * 策略分析：同一批随机种子下比较
 *   1) 纯绕环基线（只走哈密顿环下一格）
 *   2) 本策略（门控 + 安全抄近路）
 *   3) 曼哈顿距离下界
 * 并按前 25% / 中段 50% / 后 25% 统计每颗果实所需步数。
 *
 * 运行：node tools/analyze-ai.cjs
 */
const path = require('path');
const AI = require(path.join(__dirname, '..', 'ai.js'));

const COLS = AI.COLS;
const ROWS = AI.ROWS;
const CELLS = AI.N;
const TARGET_FRUIT = CELLS - 3;
const SEEDS = [1, 2, 3, 4, 5];

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
  for (const segment of snake) occupied[segment.y * COLS + segment.x] = 1;
  const free = [];
  for (let i = 0; i < CELLS; i += 1) {
    if (!occupied[i]) free.push(i);
  }
  if (!free.length) return null;
  const index = free[Math.floor(random() * free.length)];
  return { x: index % COLS, y: Math.floor(index / COLS) };
}

function play(mode, seed) {
  const random = mulberry32(seed);
  let snake = initialSnake();
  let food = spawnFood(snake, random);
  let score = 0;
  const fruitSteps = [];
  const manhattanAtSpawn = [];
  let totalSteps = 0;
  let shortcuts = 0;
  let currentFruitSteps = 0;

  while (score < TARGET_FRUIT) {
    if (!food) throw new Error('果实意外为空');
    const head = snake[0];
    manhattanAtSpawn.push(Math.abs(head.x - food.x) + Math.abs(head.y - food.y));

    let ate = false;
    while (!ate) {
      const currentHead = snake[0];
      const move = AI.nextMove(snake, food, { mode });
      if (!move) throw new Error(`seed=${seed} mode=${mode} 无合法走法`);
      if (move.jump) shortcuts += 1;

      const next = { x: currentHead.x + move.dx, y: currentHead.y + move.dy };
      const eating = next.x === food.x && next.y === food.y;
      const collisionLimit = eating ? snake.length : snake.length - 1;
      for (let i = 0; i < collisionLimit; i += 1) {
        if (snake[i].x === next.x && snake[i].y === next.y) {
          throw new Error(`seed=${seed} mode=${mode} 自撞`);
        }
      }

      snake = [next, ...snake];
      totalSteps += 1;
      currentFruitSteps += 1;

      if (eating) {
        score += 1;
        ate = true;
        fruitSteps.push(currentFruitSteps);
        currentFruitSteps = 0;
        if (score < TARGET_FRUIT) {
          food = spawnFood(snake, random);
        }
      } else {
        snake.pop();
      }
    }
  }

  if (snake.length !== CELLS) {
    throw new Error(`seed=${seed} mode=${mode} 未填满，长度=${snake.length}`);
  }
  return { score, totalSteps, fruitSteps, manhattanAtSpawn, shortcuts };
}

function phaseOf(index) {
  const ratio = index / TARGET_FRUIT;
  if (ratio < 0.25) return 'first';
  if (ratio < 0.75) return 'mid';
  return 'last';
}

function emptyBucket() {
  return { first: [], mid: [], last: [] };
}

function main() {
  console.log('SnakeAI 策略对比分析');
  console.log(`固定标准难度，种子: ${SEEDS.join(', ')}；仅速度差异，不影响决策。\n`);

  const baselineBuckets = emptyBucket();
  const strategyBuckets = emptyBucket();
  const lowerBuckets = emptyBucket();
  const totals = {
    baseline: 0,
    strategy: 0,
    lower: 0,
    baselineShortcuts: 0,
    strategyShortcuts: 0
  };
  let failures = 0;

  for (const seed of SEEDS) {
    try {
      const baseline = play('baseline', seed);
      const strategy = play('strategy', seed);

      totals.baseline += baseline.totalSteps;
      totals.strategy += strategy.totalSteps;
      totals.lower += baseline.manhattanAtSpawn.reduce((sum, value) => sum + value, 0);
      totals.baselineShortcuts += baseline.shortcuts;
      totals.strategyShortcuts += strategy.shortcuts;

      for (let i = 0; i < TARGET_FRUIT; i += 1) {
        const phase = phaseOf(i);
        baselineBuckets[phase].push(baseline.fruitSteps[i]);
        strategyBuckets[phase].push(strategy.fruitSteps[i]);
        lowerBuckets[phase].push(baseline.manhattanAtSpawn[i]);
      }

      const delta = strategy.totalSteps - baseline.totalSteps;
      console.log(
        `seed ${String(seed).padStart(2)}: 基线 ${String(baseline.totalSteps).padStart(6)} 步 | ` +
        `本策略 ${String(strategy.totalSteps).padStart(6)} 步 | ` +
        `差值 ${String(delta).padStart(4)} | 果实 ${strategy.score}/${TARGET_FRUIT}`
      );
    } catch (error) {
      failures += 1;
      console.error(`seed ${seed} FAIL: ${error.message}`);
    }
  }

  function mean(values) {
    if (!values.length) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  console.log('\n分阶段每果实平均步数');
  console.log('阶段'.padEnd(12) + '果实数'.padStart(7) + '纯绕环基线'.padStart(13) +
    '本策略'.padStart(11) + '曼哈顿下界'.padStart(13) + '策略/基线'.padStart(12));
  console.log('-'.repeat(70));

  const phaseLabels = [
    ['first', '前 25%'],
    ['mid', '中段 50%'],
    ['last', '后 25%']
  ];
  for (const [key, label] of phaseLabels) {
    const baseMean = mean(baselineBuckets[key]);
    const strategyMean = mean(strategyBuckets[key]);
    const lowerMean = mean(lowerBuckets[key]);
    const ratio = baseMean > 0 ? strategyMean / baseMean : 1;
    console.log(
      label.padEnd(12) +
      String(baselineBuckets[key].length).padStart(7) +
      baseMean.toFixed(2).padStart(13) +
      strategyMean.toFixed(2).padStart(11) +
      lowerMean.toFixed(2).padStart(13) +
      `${(ratio * 100).toFixed(1)}%`.padStart(12)
    );
  }

  console.log('-'.repeat(70));
  console.log(
    '总步数'.padEnd(12) +
    `${SEEDS.length} 局`.padStart(7) +
    String(totals.baseline).padStart(13) +
    String(totals.strategy).padStart(11) +
    String(totals.lower).padStart(13) +
    `${((totals.strategy / totals.baseline) * 100).toFixed(1)}%`.padStart(12)
  );
  console.log(`\n纯绕环跳步次数: ${totals.baselineShortcuts}`);
  console.log(`本策略安全跳步次数: ${totals.strategyShortcuts}`);
  console.log(`估算 MAX 演示时长（约 ${60 * 18} 步/秒）: ${(totals.strategy / SEEDS.length / (60 * 18)).toFixed(1)} 秒/局`);
  console.log('说明：候选捷径先做保守增长前瞻，失败就立刻退回纯环；纯环始终是完整覆盖兜底。');

  if (totals.lower > totals.strategy) {
    failures += 1;
    console.error('曼哈顿下界高于实际步数，统计异常。');
  }
  if (failures > 0) {
    console.error(`\n失败 ${failures} 项。`);
    process.exitCode = 1;
    return;
  }
  console.log('\n分析完成，0 失败。');
}

main();
