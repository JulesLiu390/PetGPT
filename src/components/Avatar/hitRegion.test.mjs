import test from 'node:test';
import assert from 'node:assert/strict';
import { CELL, MARGIN, cellRects, fitBottomCenter, growCells, regionContains, solidCells } from './hitRegion.js';

// An RGBA image `width` × `height` whose alpha is `alpha(x, y)`.
const image = (width, height, alpha) => {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data[(y * width + x) * 4 + 3] = alpha(x, y);
  }
  return data;
};

const setCells = ({ cells, cols }) => [...cells.keys()].filter(i => cells[i]).map(i => [i % cols, Math.floor(i / cols)]);

test('a cell is solid when any of its pixels is, ignoring faint ones', () => {
  const data = image(10, 6, (x, y) => (x === 5 && y === 4 ? 255 : x === 0 && y === 0 ? 20 : 0));
  const grid = solidCells(data, 10, 6, 4);
  assert.equal(grid.cols, 3);
  assert.equal(grid.rows, 2);
  assert.deepEqual(setCells(grid), [[1, 1]]);
});

test('growing reaches the margin in a disc, clipped to the grid', () => {
  const cells = new Uint8Array(81);
  cells[4 * 9 + 4] = 1;
  const grown = growCells({ cells, cols: 9, rows: 9 }, 2.5);
  const reached = setCells(grown).map(([x, y]) => [x - 4, y - 4]);
  assert.equal(reached.length, 21);
  assert.ok(reached.every(([dx, dy]) => dx * dx + dy * dy <= 6.25));
  assert.ok(!reached.some(([dx, dy]) => Math.abs(dx) === 2 && Math.abs(dy) === 2), 'corners stay out');

  const corner = new Uint8Array(16);
  corner[0] = 1;
  assert.deepEqual(setCells(growCells({ cells: corner, cols: 4, rows: 4 }, 1)), [[0, 0], [1, 0], [0, 1]]);
});

test('rectangles cover exactly the set cells, stacking repeated runs', () => {
  const rows = ['.##..##', '.##..##', '####...', '.......', '..#....'];
  const cells = Uint8Array.from(rows.join('').split(''), c => (c === '#' ? 1 : 0));
  const grid = { cells, cols: 7, rows: rows.length };
  const rects = cellRects(grid, 4);
  assert.deepEqual(rects.slice(0, 2), [
    { x: 4, y: 0, width: 8, height: 8 },
    { x: 20, y: 0, width: 8, height: 8 },
  ]);
  assert.equal(rects.length, 4);
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.cols; col += 1) {
      const covering = rects.filter(r => regionContains([r], col * 4 + 2, row * 4 + 2)).length;
      assert.equal(covering, cells[row * 7 + col], `cell ${col},${row}`);
    }
  }
});

test('without a region the whole window catches the mouse', () => {
  assert.equal(regionContains(null, 3, 3), true);
  const rects = [{ x: 10, y: 20, width: 5, height: 5 }];
  assert.equal(regionContains(rects, 10, 20), true);
  assert.equal(regionContains(rects, 15, 22), false);
  assert.equal(regionContains([], 10, 20), false);
});

test('artwork stands centered on the bottom edge, like xMidYMax meet', () => {
  const tall = fitBottomCenter([0, 0, 100, 200])({ width: 260, height: 340 });
  assert.equal(tall.scale, 1.7);
  assert.equal(tall.x, (260 - 170) / 2);
  assert.equal(tall.y, 0);
  const wide = fitBottomCenter([-20, 10, 400, 200])({ width: 200, height: 300 });
  assert.equal(wide.scale, 0.5);
  assert.equal(wide.x, 10);
  assert.equal(wide.y + (10 + 200) * wide.scale, 300, 'the bottom of the viewBox meets the bottom edge');
});

test('a figure catches the mouse a margin past its outline and nowhere far from it', () => {
  // A 40px-radius disc in the middle of a 260 × 390 window.
  const [width, height, cx, cy, r] = [260, 390, 130, 250, 40];
  const data = image(width, height, (x, y) => ((x - cx) ** 2 + (y - cy) ** 2 <= r * r ? 255 : 0));
  const rects = cellRects(growCells(solidCells(data, width, height), MARGIN / CELL));
  const inside = (x, y) => regionContains(rects, x, y);
  assert.ok(inside(cx, cy));
  assert.ok(inside(cx + r + MARGIN - 2, cy), 'just past the outline');
  assert.ok(inside(cx, cy - r - MARGIN + 2));
  assert.ok(!inside(cx + r + MARGIN + CELL + 1, cy), 'beyond the margin');
  assert.ok(!inside(10, 10) && !inside(250, 380), 'empty corners');
  assert.ok(rects.length < 40, `${rects.length} rectangles`);
});
