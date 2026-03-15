"use client";

import { useEffect, useRef } from "react";

const CELL = 48;
const RADIUS = 180;
const RADIUS_SQ = RADIUS * RADIUS;
const INV_RADIUS = 1 / RADIUS;
const STRENGTH = 20;
const OFFSCREEN = -10_000;
const TAU = Math.PI * 2;

const STROKE_BUCKET_COUNT = 6;
const DOT_BUCKET_COUNT = 5;

const BASE_GRID_ALPHA = 0.08;
const STROKE_MIN_ALPHA = 0.05;
const STROKE_MAX_ALPHA = 0.35;
const DOT_MIN_ALPHA = 0.06;
const DOT_MAX_ALPHA = 0.6;

const STEP_NEAR = 4;
const STEP_MID = 8;
const STEP_FAR = 12;

const STEP_NEAR_RADIUS_SQ = (RADIUS * 0.35) ** 2;
const STEP_MID_RADIUS_SQ = (RADIUS * 0.72) ** 2;

const DOT_THRESHOLD = 0.05;
const AMBER = "245,166,35";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function createColorScale(count: number, minAlpha: number, maxAlpha: number) {
  if (count === 1) {
    return [`rgba(${AMBER},${maxAlpha})`];
  }
  return Array.from({ length: count }, (_, index) => {
    const t = index / (count - 1);
    const alpha = minAlpha + (maxAlpha - minAlpha) * t;
    return `rgba(${AMBER},${alpha})`;
  });
}

function getBucketIndex(t: number, bucketCount: number) {
  return clamp(Math.round(t * (bucketCount - 1)), 0, bucketCount - 1);
}

function buildGridStops(size: number) {
  const stops: number[] = [];
  for (let value = 0; value <= size; value += CELL) {
    stops.push(value);
  }
  return stops;
}

const STROKE_STYLES = createColorScale(
  STROKE_BUCKET_COUNT,
  STROKE_MIN_ALPHA,
  STROKE_MAX_ALPHA,
);

const DOT_STYLES = createColorScale(
  DOT_BUCKET_COUNT,
  DOT_MIN_ALPHA,
  DOT_MAX_ALPHA,
);

export function WarpGrid() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouseRef = useRef({ x: OFFSCREEN, y: OFFSCREEN });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let frameId = 0;
    let drawScheduled = false;
    let horizontalLines = buildGridStops(window.innerHeight);
    let verticalLines = buildGridStops(window.innerWidth);

    const strokeBuckets = Array.from(
      { length: STROKE_BUCKET_COUNT },
      () => [] as number[],
    );

    const dotBuckets = Array.from(
      { length: DOT_BUCKET_COUNT },
      () => [] as number[],
    );

    function clearBuckets() {
      for (const bucket of strokeBuckets) bucket.length = 0;
      for (const bucket of dotBuckets) bucket.length = 0;
    }

    function getStep(distSq: number) {
      if (distSq <= STEP_NEAR_RADIUS_SQ) return STEP_NEAR;
      if (distSq <= STEP_MID_RADIUS_SQ) return STEP_MID;
      return STEP_FAR;
    }

    function getFalloff(distSq: number) {
      if (distSq >= RADIUS_SQ) return 0;
      return 1 - Math.sqrt(distSq) * INV_RADIUS;
    }

    function warpPoint(px: number, py: number, mx: number, my: number) {
      const dx = px - mx;
      const dy = py - my;
      const distSq = dx * dx + dy * dy;

      if (distSq >= RADIUS_SQ || distSq < 0.0001) {
        return [px, py] as const;
      }

      const dist = Math.sqrt(distSq);
      const t = 1 - dist * INV_RADIUS;
      const force = (t * t * STRENGTH) / dist;

      return [px + dx * force, py + dy * force] as const;
    }

    function pushStrokeSegment(
      bucketIndex: number,
      x1: number,
      y1: number,
      x2: number,
      y2: number,
    ) {
      strokeBuckets[bucketIndex].push(x1, y1, x2, y2);
    }

    function pushDot(bucketIndex: number, x: number, y: number, radius: number) {
      dotBuckets[bucketIndex].push(x, y, radius);
    }

    function appendHorizontalLine(baseY: number, width: number, mx: number, my: number) {
      const dy = baseY - my;
      const dySq = dy * dy;

      if (dySq >= RADIUS_SQ) {
        pushStrokeSegment(0, 0, baseY, width, baseY);
        return;
      }

      const influenceHalfWidth = Math.sqrt(RADIUS_SQ - dySq);
      const influenceStart = clamp(mx - influenceHalfWidth, 0, width);
      const influenceEnd = clamp(mx + influenceHalfWidth, 0, width);

      if (influenceStart > 0) {
        pushStrokeSegment(0, 0, baseY, influenceStart, baseY);
      }

      let x = influenceStart;
      let prevX = influenceStart;
      let prevY = baseY;

      while (x < influenceEnd) {
        const dx = x - mx;
        const distSq = dx * dx + dySq;
        const nextX = Math.min(influenceEnd, x + getStep(distSq));
        const midX = (x + nextX) * 0.5;
        const midDx = midX - mx;
        const midDistSq = midDx * midDx + dySq;
        const [wx, wy] = warpPoint(nextX, baseY, mx, my);
        const t = getFalloff(midDistSq);

        pushStrokeSegment(
          getBucketIndex(t, STROKE_BUCKET_COUNT),
          prevX,
          prevY,
          wx,
          wy,
        );

        prevX = wx;
        prevY = wy;
        x = nextX;
      }

      if (influenceEnd < width) {
        pushStrokeSegment(0, influenceEnd, baseY, width, baseY);
      }
    }

    function appendVerticalLine(baseX: number, height: number, mx: number, my: number) {
      const dx = baseX - mx;
      const dxSq = dx * dx;

      if (dxSq >= RADIUS_SQ) {
        pushStrokeSegment(0, baseX, 0, baseX, height);
        return;
      }

      const influenceHalfHeight = Math.sqrt(RADIUS_SQ - dxSq);
      const influenceStart = clamp(my - influenceHalfHeight, 0, height);
      const influenceEnd = clamp(my + influenceHalfHeight, 0, height);

      if (influenceStart > 0) {
        pushStrokeSegment(0, baseX, 0, baseX, influenceStart);
      }

      let y = influenceStart;
      let prevX = baseX;
      let prevY = influenceStart;

      while (y < influenceEnd) {
        const dy = y - my;
        const distSq = dxSq + dy * dy;
        const nextY = Math.min(influenceEnd, y + getStep(distSq));
        const midY = (y + nextY) * 0.5;
        const midDy = midY - my;
        const midDistSq = dxSq + midDy * midDy;
        const [wx, wy] = warpPoint(baseX, nextY, mx, my);
        const t = getFalloff(midDistSq);

        pushStrokeSegment(
          getBucketIndex(t, STROKE_BUCKET_COUNT),
          prevX,
          prevY,
          wx,
          wy,
        );

        prevX = wx;
        prevY = wy;
        y = nextY;
      }

      if (influenceEnd < height) {
        pushStrokeSegment(0, baseX, influenceEnd, baseX, height);
      }
    }

    function drawStrokeBuckets() {
      ctx!.lineWidth = 0.5;

      for (let i = 0; i < strokeBuckets.length; i += 1) {
        const bucket = strokeBuckets[i];
        if (bucket.length === 0) continue;

        ctx!.beginPath();

        for (let j = 0; j < bucket.length; j += 4) {
          ctx!.moveTo(bucket[j], bucket[j + 1]);
          ctx!.lineTo(bucket[j + 2], bucket[j + 3]);
        }

        ctx!.strokeStyle = STROKE_STYLES[i];
        ctx!.stroke();
      }
    }

    function drawDotBuckets() {
      for (let i = 0; i < dotBuckets.length; i += 1) {
        const bucket = dotBuckets[i];
        if (bucket.length === 0) continue;

        ctx!.beginPath();

        for (let j = 0; j < bucket.length; j += 3) {
          const x = bucket[j];
          const y = bucket[j + 1];
          const radius = bucket[j + 2];

          ctx!.moveTo(x + radius, y);
          ctx!.arc(x, y, radius, 0, TAU);
        }

        ctx!.fillStyle = DOT_STYLES[i];
        ctx!.fill();
      }
    }

    function drawDots(width: number, height: number, mx: number, my: number) {
      const startRow = clamp(Math.floor((my - RADIUS) / CELL), 0, horizontalLines.length - 1);
      const endRow = clamp(Math.ceil((my + RADIUS) / CELL), 0, horizontalLines.length - 1);
      const startCol = clamp(Math.floor((mx - RADIUS) / CELL), 0, verticalLines.length - 1);
      const endCol = clamp(Math.ceil((mx + RADIUS) / CELL), 0, verticalLines.length - 1);

      if (
        mx < -RADIUS ||
        my < -RADIUS ||
        mx > width + RADIUS ||
        my > height + RADIUS
      ) {
        return;
      }

      for (let row = startRow; row <= endRow; row += 1) {
        const oy = horizontalLines[row];
        const dy = oy - my;
        const dySq = dy * dy;

        if (dySq >= RADIUS_SQ) continue;

        for (let col = startCol; col <= endCol; col += 1) {
          const ox = verticalLines[col];
          const dx = ox - mx;
          const distSq = dx * dx + dySq;

          if (distSq >= RADIUS_SQ) continue;

          const t = getFalloff(distSq);
          if (t <= DOT_THRESHOLD) continue;

          const [wx, wy] = warpPoint(ox, oy, mx, my);
          const radius = 1.5 + t * 2;

          pushDot(getBucketIndex(t, DOT_BUCKET_COUNT), wx, wy, radius);
        }
      }
    }

    function drawBaseGrid(width: number, height: number) {
      ctx!.strokeStyle = `rgba(${AMBER},${BASE_GRID_ALPHA})`;
      ctx!.lineWidth = 0.5;
      ctx!.beginPath();
      for (let i = 0; i < horizontalLines.length; i += 1) {
        const y = horizontalLines[i];
        ctx!.moveTo(0, y);
        ctx!.lineTo(width, y);
      }
      for (let i = 0; i < verticalLines.length; i += 1) {
        const x = verticalLines[i];
        ctx!.moveTo(x, 0);
        ctx!.lineTo(x, height);
      }
      ctx!.stroke();
    }

    function draw() {
      const width = canvas!.width;
      const height = canvas!.height;
      const { x: mx, y: my } = mouseRef.current;

      clearBuckets();
      ctx!.clearRect(0, 0, width, height);

      // Always-visible base grid
      drawBaseGrid(width, height);

      // Warp effect near cursor
      for (let i = 0; i < horizontalLines.length; i += 1) {
        appendHorizontalLine(horizontalLines[i], width, mx, my);
      }

      for (let i = 0; i < verticalLines.length; i += 1) {
        appendVerticalLine(verticalLines[i], height, mx, my);
      }

      drawStrokeBuckets();
      drawDots(width, height, mx, my);
      drawDotBuckets();
    }

    function scheduleDraw() {
      if (drawScheduled) return;

      drawScheduled = true;
      frameId = window.requestAnimationFrame(() => {
        drawScheduled = false;
        draw();
      });
    }

    function resize() {
      const width = window.innerWidth;
      const height = window.innerHeight;

      if (canvas!.width !== width) {
        canvas!.width = width;
      }

      if (canvas!.height !== height) {
        canvas!.height = height;
      }

      horizontalLines = buildGridStops(height);
      verticalLines = buildGridStops(width);
      scheduleDraw();
    }

    function onMouseMove(event: MouseEvent) {
      const nextX = event.clientX;
      const nextY = event.clientY;
      const { x, y } = mouseRef.current;

      if (x === nextX && y === nextY) return;

      mouseRef.current.x = nextX;
      mouseRef.current.y = nextY;
      scheduleDraw();
    }

    function resetMouse() {
      if (
        mouseRef.current.x === OFFSCREEN &&
        mouseRef.current.y === OFFSCREEN
      ) {
        return;
      }

      mouseRef.current.x = OFFSCREEN;
      mouseRef.current.y = OFFSCREEN;
      scheduleDraw();
    }

    function onMouseOut(event: MouseEvent) {
      if (event.relatedTarget !== null) return;
      resetMouse();
    }

    resize();

    window.addEventListener("resize", resize, { passive: true });
    window.addEventListener("mousemove", onMouseMove, { passive: true });
    window.addEventListener("mouseout", onMouseOut, { passive: true });
    window.addEventListener("blur", resetMouse);

    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener("resize", resize);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseout", onMouseOut);
      window.removeEventListener("blur", resetMouse);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none fixed inset-0 z-0"
      aria-hidden="true"
    />
  );
}
