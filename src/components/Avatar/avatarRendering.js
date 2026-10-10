/**
 * The generated fallback patches expanded their alpha mask onto transparent
 * black pixels without extending RGB. Fill only those missing colors from the
 * nearest colored pixel; preserve connected coverage and leave source PNGs
 * untouched. Isolated black islands with no source color are mask artifacts.
 * This is specific to these generated patches, not a filter for arbitrary art.
 */
export function repairGeneratedEdgeColors(data, width, height) {
  const count = width * height;
  const owners = new Int32Array(count).fill(-1);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;

  for (let pixel = 0; pixel < count; pixel += 1) {
    const i = pixel * 4;
    if (data[i + 3] && (data[i] || data[i + 1] || data[i + 2])) {
      owners[pixel] = pixel;
      queue[tail++] = pixel;
    }
  }

  // Restrict propagation to the visible mask, so disconnected shapes cannot
  // acquire color from an unrelated part across transparent space.
  const visit = (pixel, owner) => {
    if (owners[pixel] !== -1 || !data[pixel * 4 + 3]) return;
    owners[pixel] = owner;
    const i = pixel * 4;
    const source = owner * 4;
    data[i] = data[source];
    data[i + 1] = data[source + 1];
    data[i + 2] = data[source + 2];
    queue[tail++] = pixel;
  };
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const owner = owners[pixel];
    if (x > 0) visit(pixel - 1, owner);
    if (x + 1 < width) visit(pixel + 1, owner);
    if (pixel >= width) visit(pixel - width, owner);
    if (pixel + width < count) visit(pixel + width, owner);
  }
  for (let pixel = 0; pixel < count; pixel += 1) {
    if (owners[pixel] === -1) data[pixel * 4 + 3] = 0;
  }
  return data;
}

export function blinkScaleAt(seconds) {
  const local = seconds - 1.8;
  if (local < 0) return 1;
  const cycle = Math.floor(local / 4);
  const age = local - cycle * 4;
  const pulse = (t) => t < 0 || t > 0.24 ? 1 : 1 - Math.sin(t / 0.24 * Math.PI) * 0.92;
  return Math.min(pulse(age), cycle % 5 === 2 ? pulse(age - 0.18) : 1);
}

export function mouthFrameAt(mood, seconds, frameCount = 4) {
  let level = 0;
  if (mood === 'thinking') level = 0.22 + Math.abs(Math.sin(seconds * 8.2)) * 0.62;
  else if (mood === 'shocked') level = 1;
  else if (mood === 'smile') level = 0.42;
  // Normal, sad and idle moods keep the closed mouth.
  const amount = level < 0.08 ? 0 : Math.min(1, (level - 0.08) / 0.82);
  return amount === 0 ? 0 : Math.min(frameCount - 1, Math.max(1, Math.round(amount * (frameCount - 1))));
}
