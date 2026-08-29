import { resolveToken, resolveTypeColor } from "../lib/graph.js";

// 画布不得写死亮色底值：所有用色经 resolveToken 取当前主题 token。
// 兜底数组 = 亮色既有视觉等价物，token 缺失时不退化成白底。
function hexToRgb(value) {
  const match = /^#([0-9a-f]{6})$/i.exec(String(value || "").trim());
  if (!match) return null;
  const int = parseInt(match[1], 16);
  return [(int >> 16) & 255, (int >> 8) & 255, int & 255];
}

function mixRgb(from, to, weight) {
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * weight));
}

function rgbaOf(rgb, alpha) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})`;
}

function framePalette() {
  const accent = hexToRgb(resolveToken("--accent")) || [124, 58, 237];
  const line = hexToRgb(resolveToken("--line")) || [236, 236, 238];
  return {
    accent,
    accentStrong: hexToRgb(resolveToken("--accent-strong")) || [109, 40, 217],
    inkSoft: hexToRgb(resolveToken("--ink-soft")) || [82, 82, 91],
    lineStrong: hexToRgb(resolveToken("--line-strong")) || [220, 220, 224],
    paper: hexToRgb(resolveToken("--paper")) || [250, 250, 250],
    surface: hexToRgb(resolveToken("--surface")) || [255, 255, 255],
    // 连线底色 = line 与 accent 的混合；亮色下 ≈ 原硬编码淡紫 rgb(185, 166, 234)。
    linkBase: mixRgb(line, accent, 0.45),
  };
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function linkGeometry(linkFrame, scale) {
  const { link, source, target } = linkFrame;
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const curve = link.curve / Math.max(0.6, scale);
  return {
    controlX: (source.x + target.x) / 2 - (dy / length) * curve,
    controlY: (source.y + target.y) / 2 + (dx / length) * curve,
  };
}

function drawLink(ctx, frame, scale, palette) {
  if (frame.alpha < 0.006) return;
  const geometry = linkGeometry(frame, scale);
  const emphasis = Math.max(frame.focusWeight, frame.hoverWeight);
  ctx.save();
  ctx.globalAlpha = frame.alpha;
  ctx.beginPath();
  ctx.moveTo(frame.source.x, frame.source.y);
  ctx.quadraticCurveTo(
    geometry.controlX,
    geometry.controlY,
    frame.target.x,
    frame.target.y,
  );
  const tone = Math.min(1, Math.max(0, emphasis));
  ctx.strokeStyle = rgbaOf(mixRgb(palette.linkBase, palette.accent, tone), 1);
  ctx.lineWidth =
    (0.62 + emphasis * (0.62 + Math.log2(frame.link.weight + 1) * 0.08)) / scale;
  ctx.stroke();
  ctx.restore();
}

function drawNode(ctx, frame, scale, palette) {
  const { node, x, y } = frame;
  if (frame.opacity < 0.006) return;
  const scaleWeight = 1 + frame.hoverWeight * 0.06 + frame.selectionWeight * 0.025;
  const radius = frame.radius * scaleWeight * (0.66 + frame.opacity * 0.34);

  ctx.save();
  ctx.globalAlpha = frame.opacity;
  if (Number(node.degree) >= 18 && frame.opacity > 0.3) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 5.5 / scale, 0, Math.PI * 2);
    ctx.fillStyle = rgbaOf(palette.accent, 0.055 + frame.selectionWeight * 0.045);
    ctx.fill();
  }
  if (frame.hoverWeight > 0.006 || frame.selectionWeight > 0.006) {
    const weight = Math.max(frame.hoverWeight * 0.72, frame.selectionWeight);
    ctx.beginPath();
    ctx.arc(x, y, radius + (4.5 + weight * 1.5) / scale, 0, Math.PI * 2);
    ctx.strokeStyle = rgbaOf(palette.accent, 0.08 + weight * 0.22);
    ctx.lineWidth = (0.8 + weight * 0.45) / scale;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = resolveTypeColor(node.type);
  ctx.fill();
  ctx.lineWidth = (1.05 + frame.selectionWeight * 0.9) / scale;
  ctx.strokeStyle = rgbaOf(palette.lineStrong, 0.92);
  ctx.stroke();
  if (frame.selectionWeight > 0.01) {
    ctx.globalAlpha = frame.opacity * frame.selectionWeight;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.5 / scale, radius * 0.24), 0, Math.PI * 2);
    ctx.fillStyle = rgbaOf(palette.paper, 1);
    ctx.fill();
  }
  ctx.restore();
}

function drawLabel(ctx, label, palette) {
  if (label.opacity < 0.006) return;
  ctx.save();
  ctx.globalAlpha = label.opacity;
  ctx.font = label.font;
  ctx.textBaseline = "middle";
  if (label.selected) {
    ctx.shadowColor = rgbaOf(palette.accent, 0.14);
    ctx.shadowBlur = 14;
    ctx.shadowOffsetY = 4;
    roundedRect(ctx, label.x, label.y, label.width, label.height, 8);
    ctx.fillStyle = rgbaOf(palette.surface, 0.97);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.lineWidth = 1;
    ctx.strokeStyle = rgbaOf(palette.accent, 0.7);
    ctx.stroke();
  } else {
    ctx.lineJoin = "round";
    ctx.lineWidth = 4;
    ctx.strokeStyle = rgbaOf(palette.surface, 0.96);
    ctx.strokeText(label.text, label.x + label.padX, label.y + label.height / 2 + 0.5);
  }
  ctx.fillStyle = rgbaOf(label.selected ? palette.accentStrong : palette.inkSoft, 1);
  ctx.fillText(label.text, label.x + label.padX, label.y + label.height / 2 + 0.5);
  ctx.restore();
}

/** Pure drawing: all interaction decisions live in the scene engine. */
export function renderGraphFrame(ctx, frame) {
  const { canvas, dpr, labels, links, nodes, view } = frame;
  const palette = framePalette();
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.translate(view.x, view.y);
  ctx.scale(view.k, view.k);
  for (const link of links) drawLink(ctx, link, view.k, palette);
  for (const node of nodes) {
    if (node.hoverWeight < 0.008 && node.selectionWeight < 0.008) {
      drawNode(ctx, node, view.k, palette);
    }
  }
  for (const node of nodes) {
    if (node.hoverWeight >= 0.008 && node.selectionWeight < 0.008) {
      drawNode(ctx, node, view.k, palette);
    }
  }
  for (const node of nodes) {
    if (node.selectionWeight >= 0.008) drawNode(ctx, node, view.k, palette);
  }
  ctx.restore();

  if (labels?.length) {
    ctx.save();
    ctx.scale(dpr, dpr);
    for (const label of labels) drawLabel(ctx, label, palette);
    ctx.restore();
  }
}
