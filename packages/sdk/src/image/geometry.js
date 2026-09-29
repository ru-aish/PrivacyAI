export function scaleBox(box, scale) {
  return [
    Math.floor(Number(box?.x0 || 0) * scale),
    Math.floor(Number(box?.y0 || 0) * scale),
    Math.ceil(Number(box?.x1 || 0) * scale),
    Math.ceil(Number(box?.y1 || 0) * scale)
  ];
}

export function unionBoxes(boxes) {
  if (!Array.isArray(boxes) || boxes.length === 0) {
    throw new TypeError("PrivacyAI requires at least one image region box.");
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const box of boxes) {
    if (box[0] < x0) x0 = box[0];
    if (box[1] < y0) y0 = box[1];
    if (box[2] > x1) x1 = box[2];
    if (box[3] > y1) y1 = box[3];
  }
  return [x0, y0, x1, y1];
}

export function expandBox(box, horizontal, vertical) {
  return [
    box[0] - horizontal,
    box[1] - vertical,
    box[2] + horizontal,
    box[3] + vertical
  ];
}

export function clampBox(box, width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError("PrivacyAI requires positive integer image dimensions.");
  }
  const x0 = Math.max(0, Math.min(width - 1, Math.floor(box[0])));
  const y0 = Math.max(0, Math.min(height - 1, Math.floor(box[1])));
  const x1 = Math.max(x0 + 1, Math.min(width, Math.ceil(box[2])));
  const y1 = Math.max(y0 + 1, Math.min(height, Math.ceil(box[3])));
  return [x0, y0, x1, y1];
}

export function overlapOverMinimum(left, right) {
  const x0 = Math.max(left[0], right[0]);
  const y0 = Math.max(left[1], right[1]);
  const x1 = Math.min(left[2], right[2]);
  const y1 = Math.min(left[3], right[3]);
  const intersection = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const leftArea = Math.max(1, (left[2] - left[0]) * (left[3] - left[1]));
  const rightArea = Math.max(1, (right[2] - right[0]) * (right[3] - right[1]));
  return intersection / Math.min(leftArea, rightArea);
}
