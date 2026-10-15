// Where the pet catches the mouse: its solid pixels grown by a margin, as rectangles in window CSS
// pixels. The rest of its window lets clicks through to whatever is behind it.
//
// A renderer describes its artwork at rest as a hit shape: `images`, each `{ src, x, y, width,
// height }` in the renderer's own units, and `place(box)`, which maps those units into the
// renderer's `{ width, height }` box as `{ scale, x, y }` in CSS pixels. An animated GIF counts with
// its first frame's outline.

// The region is kept on a grid of cells this many CSS pixels wide.
export const CELL = 4;
// How far the region reaches past the artwork, in CSS pixels. Breathing, tilts, hops and gusts move
// the outline by up to about this much.
export const MARGIN = 10;
// Alpha below which a pixel counts as empty, so faint glows and shadows stay click-through.
const SOLID_ALPHA = 32;

/** Cells of a grid over an RGBA image that hold at least one solid pixel. */
export function solidCells(data, width, height, cell = CELL) {
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  const cells = new Uint8Array(cols * rows);
  for (let y = 0; y < height; y += 1) {
    const row = Math.floor(y / cell) * cols;
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] >= SOLID_ALPHA) cells[row + Math.floor(x / cell)] = 1;
    }
  }
  return { cells, cols, rows };
}

/** Grows the set cells by `radius` cells in every direction. */
export function growCells({ cells, cols, rows }, radius) {
  const reach = Math.floor(radius);
  const offsets = [];
  for (let dy = -reach; dy <= reach; dy += 1) {
    for (let dx = -reach; dx <= reach; dx += 1) {
      if (dx * dx + dy * dy <= radius * radius) offsets.push([dx, dy]);
    }
  }
  const grown = new Uint8Array(cells.length);
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (!cells[row * cols + col]) continue;
      for (const [dx, dy] of offsets) {
        const x = col + dx;
        const y = row + dy;
        if (x >= 0 && x < cols && y >= 0 && y < rows) grown[y * cols + x] = 1;
      }
    }
  }
  return { cells: grown, cols, rows };
}

/** Covers the set cells with rectangles: runs along each row, stretched down while rows repeat them. */
export function cellRects({ cells, cols, rows }, cell = CELL) {
  const rects = [];
  let open = new Map();
  for (let row = 0; row < rows; row += 1) {
    const next = new Map();
    let col = 0;
    while (col < cols) {
      if (!cells[row * cols + col]) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < cols && cells[row * cols + col]) col += 1;
      const key = `${start},${col}`;
      let rect = open.get(key);
      if (rect) {
        rect.height += cell;
      } else {
        rect = { x: start * cell, y: row * cell, width: (col - start) * cell, height: cell };
        rects.push(rect);
      }
      next.set(key, rect);
    }
    open = next;
  }
  return rects;
}

/** Whether a point in window CSS pixels catches the mouse; without a region everywhere does. */
export function regionContains(rects, x, y) {
  return !rects || rects.some(rect => x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height);
}

/**
 * Placement of `preserveAspectRatio="xMidYMax meet"`, which `object-fit: contain` with
 * `object-position: center bottom` shares: as large as fits, centered, standing on the bottom edge.
 */
export const fitBottomCenter = ([left, top, width, height]) => (box) => {
  const scale = Math.min(box.width / width, box.height / height);
  return { scale, x: (box.width - width * scale) / 2 - left * scale, y: box.height - height * scale - top * scale };
};

/** Where an element comes to rest, grown by `padding`: offsets ignore its slide-in transform. */
export function restingRect(element, padding = 0) {
  const frame = element.offsetParent?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return {
    x: frame.left + element.offsetLeft - padding,
    y: frame.top + element.offsetTop - padding,
    width: element.offsetWidth + padding * 2,
    height: element.offsetHeight + padding * 2,
  };
}

const loadImage = src => new Promise((resolve, reject) => {
  const image = new Image();
  // Skin files come over the asset protocol, which allows this origin; without CORS they would
  // taint the canvas and its pixels could not be read.
  image.crossOrigin = 'anonymous';
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`Could not load ${src}`));
  image.src = src;
});

/**
 * Draws `shape` at rest in `box` (window CSS pixels) and returns where it catches the mouse within
 * a `width` × `height` window.
 */
export async function measureHitRegion(shape, box, width, height) {
  const images = await Promise.all(shape.images.map(item => loadImage(item.src)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width);
  canvas.height = Math.ceil(height);
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('Canvas 2D is unavailable');
  const { scale, x, y } = shape.place(box);
  shape.images.forEach((item, index) => {
    context.drawImage(images[index], box.left + x + item.x * scale, box.top + y + item.y * scale, item.width * scale, item.height * scale);
  });
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  return cellRects(growCells(solidCells(data, canvas.width, canvas.height), MARGIN / CELL));
}
