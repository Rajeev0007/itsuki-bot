/**
 * @file CaptchaCanvas.ts
 * @description Renders a distorted text captcha.
 *
 * Throws if the native `canvas` binding is unavailable — callers fall back to
 * the maths challenge, so image rendering is never a hard requirement.
 */

import { createCanvas, type Ctx } from './canvas/CanvasKit';

const W = 420, H = 150;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Noise lines drawn behind the text to defeat naive OCR. */
function drawNoise(ctx: Ctx): void {
  for (let i = 0; i < 8; i++) {
    ctx.strokeStyle = `rgba(${rand(90, 190) | 0},${rand(90, 190) | 0},${rand(90, 190) | 0},0.55)`;
    ctx.lineWidth = rand(1, 2.5);
    ctx.beginPath();
    ctx.moveTo(rand(0, W), rand(0, H));
    ctx.quadraticCurveTo(rand(0, W), rand(0, H), rand(0, W), rand(0, H));
    ctx.stroke();
  }
  for (let i = 0; i < 90; i++) {
    ctx.fillStyle = `rgba(${rand(80, 200) | 0},${rand(80, 200) | 0},${rand(80, 200) | 0},0.5)`;
    ctx.fillRect(rand(0, W), rand(0, H), rand(1, 3), rand(1, 3));
  }
}

export function renderCaptcha(text: string): Buffer {
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // Background gradient — a flat colour makes thresholding trivial.
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#1B1E24');
  bg.addColorStop(1, '#2A2F3A');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  drawNoise(ctx);

  const chars = String(text).split('');
  const slot = (W - 60) / Math.max(1, chars.length);

  ctx.textBaseline = 'middle';
  chars.forEach((ch, i) => {
    const size = rand(44, 58);
    ctx.font = `bold ${size}px sans-serif`;

    // Per-character colour and vertical jitter, so characters don't share a
    // baseline or palette.
    ctx.fillStyle = `hsl(${rand(0, 360) | 0}, 70%, 78%)`;

    const x = 30 + i * slot + rand(-4, 4);
    const y = H / 2 + rand(-14, 14);

    // node-canvas has no rotate() in the shim, so slant is faked by drawing
    // the character twice with a small offset and partial alpha.
    ctx.globalAlpha = 0.35;
    ctx.fillText(ch, x + rand(-3, 3), y + rand(-3, 3));
    ctx.globalAlpha = 1;
    ctx.fillText(ch, x, y);
  });

  // Strike-through lines over the text.
  for (let i = 0; i < 3; i++) {
    ctx.strokeStyle = `rgba(${rand(140, 230) | 0},${rand(140, 230) | 0},${rand(140, 230) | 0},0.45)`;
    ctx.lineWidth = rand(1.5, 3);
    ctx.beginPath();
    ctx.moveTo(0, rand(20, H - 20));
    ctx.lineTo(W, rand(20, H - 20));
    ctx.stroke();
  }

  return canvas.toBuffer('image/png');
}
