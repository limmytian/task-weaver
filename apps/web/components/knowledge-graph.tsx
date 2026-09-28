"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  FileText,
  CheckSquare,
  ClipboardList,
  Link2,
  Unplug,
  Network,
  Maximize2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { trpc } from "@/trpc/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

// ── Constants ─────────────────────────────────────────────────────────────────

const NODE_COLORS: Record<string, string> = {
  document: "#3b82f6",
  task: "#22c55e",
  requirement: "#a855f7",
};

const NODE_RADII: Record<string, number> = {
  requirement: 10,
  document: 7,
  task: 6,
};

const REPULSION = 3000;
const ATTRACTION = 0.005;
const CENTER_GRAVITY = 0.01;
const DAMPING = 0.9;
const MIN_DISTANCE = 30;
const MAX_ITERATIONS = 300;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
const FIT_PADDING = 40;

// ── Types ─────────────────────────────────────────────────────────────────────

interface SimNode {
  id: string;
  type: "document" | "task" | "requirement";
  label: string;
  metadata: Record<string, unknown>;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
  edgeCount: number;
}

interface SimEdge {
  source: string;
  target: string;
  linkType: string;
}

interface GraphNode {
  id: string;
  type: "document" | "task" | "requirement";
  label: string;
  metadata: Record<string, unknown>;
}

interface GraphEdge {
  source: string;
  target: string;
  linkType: string;
}

interface Camera {
  x: number;
  y: number;
  zoom: number;
}

// ── Simulation ────────────────────────────────────────────────────────────────

function buildSimulation(
  nodes: GraphNode[],
  edges: GraphEdge[],
): { nodes: SimNode[]; edges: SimEdge[] } {
  const edgeCounts = new Map<string, number>();
  for (const e of edges) {
    edgeCounts.set(e.source, (edgeCounts.get(e.source) ?? 0) + 1);
    edgeCounts.set(e.target, (edgeCounts.get(e.target) ?? 0) + 1);
  }

  const simNodes: SimNode[] = nodes.map((n) => ({
    ...n,
    x: (Math.random() - 0.5) * 400,
    y: (Math.random() - 0.5) * 400,
    vx: 0,
    vy: 0,
    pinned: false,
    edgeCount: edgeCounts.get(n.id) ?? 0,
  }));

  return { nodes: simNodes, edges };
}

function tickSimulation(nodes: SimNode[], edges: SimEdge[]) {
  const nodeMap = new Map<string, SimNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < MIN_DISTANCE) dist = MIN_DISTANCE;
      const force = REPULSION / (dist * dist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (!a.pinned) { a.vx -= fx; a.vy -= fy; }
      if (!b.pinned) { b.vx += fx; b.vy += fy; }
    }
  }

  for (const e of edges) {
    const a = nodeMap.get(e.source);
    const b = nodeMap.get(e.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist === 0) continue;
    const force = dist * ATTRACTION;
    const fx = (dx / dist) * force;
    const fy = (dy / dist) * force;
    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  }

  for (const n of nodes) {
    if (n.pinned) continue;
    n.vx += (0 - n.x) * CENTER_GRAVITY;
    n.vy += (0 - n.y) * CENTER_GRAVITY;
    n.vx *= DAMPING;
    n.vy *= DAMPING;
    n.x += n.vx;
    n.y += n.vy;
  }
}

// ── Camera helpers ────────────────────────────────────────────────────────────

function computeFitCamera(
  nodes: SimNode[],
  canvasW: number,
  canvasH: number,
): Camera {
  if (nodes.length === 0) return { x: 0, y: 0, zoom: 1 };

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const r = NODE_RADII[n.type] ?? 6;
    if (n.x - r < minX) minX = n.x - r;
    if (n.x + r > maxX) maxX = n.x + r;
    if (n.y - r < minY) minY = n.y - r;
    if (n.y + r > maxY) maxY = n.y + r;
  }

  const graphW = maxX - minX || 1;
  const graphH = maxY - minY || 1;
  const zoom = Math.min(
    (canvasW - FIT_PADDING * 2) / graphW,
    (canvasH - FIT_PADDING * 2) / graphH,
    MAX_ZOOM,
  );
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return { x: canvasW / 2 - cx * zoom, y: canvasH / 2 - cy * zoom, zoom: Math.max(MIN_ZOOM, zoom) };
}

/** Convert screen (canvas CSS) pixel to world coordinate. */
function screenToWorld(sx: number, sy: number, cam: Camera): { wx: number; wy: number } {
  return { wx: (sx - cam.x) / cam.zoom, wy: (sy - cam.y) / cam.zoom };
}

// ── Drawing ───────────────────────────────────────────────────────────────────

function drawGraph(
  ctx: CanvasRenderingContext2D,
  nodes: SimNode[],
  edges: SimEdge[],
  width: number,
  height: number,
  cam: Camera,
  hoveredId: string | null,
  focusNodeId: string | undefined,
  dpr: number,
) {
  const nodeMap = new Map<string, SimNode>();
  for (const n of nodes) nodeMap.set(n.id, n);

  const connectedToHovered = new Set<string>();
  if (hoveredId) {
    connectedToHovered.add(hoveredId);
    for (const e of edges) {
      if (e.source === hoveredId) connectedToHovered.add(e.target);
      if (e.target === hoveredId) connectedToHovered.add(e.source);
    }
  }

  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, width, height);
  ctx.translate(cam.x, cam.y);
  ctx.scale(cam.zoom, cam.zoom);

  for (const e of edges) {
    const a = nodeMap.get(e.source);
    const b = nodeMap.get(e.target);
    if (!a || !b) continue;
    const highlighted = hoveredId && connectedToHovered.has(e.source) && connectedToHovered.has(e.target);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = highlighted ? "rgba(148,163,184,0.8)" : "rgba(148,163,184,0.25)";
    ctx.lineWidth = (highlighted ? 1.5 : 0.8) / cam.zoom;
    ctx.stroke();
  }

  const invZoom = 1 / cam.zoom;

  for (const n of nodes) {
    const r = NODE_RADII[n.type] ?? 6;
    const color = NODE_COLORS[n.type] ?? "#94a3b8";
    const isHovered = n.id === hoveredId;
    const isFocused = n.id === focusNodeId;
    const isNeighbor = connectedToHovered.has(n.id);
    const dimmed = hoveredId && !isHovered && !isNeighbor;

    ctx.beginPath();
    ctx.arc(n.x, n.y, isHovered || isFocused ? r + 3 : r, 0, Math.PI * 2);
    ctx.fillStyle = dimmed ? `${color}44` : color;
    ctx.fill();

    if (isHovered || isFocused) {
      ctx.strokeStyle = isFocused ? "rgba(255,255,255,0.95)" : "white";
      ctx.lineWidth = (isFocused ? 3 : 2) * invZoom;
      ctx.stroke();
    }

    const showLabel = isHovered || isNeighbor || n.edgeCount <= 2;
    if (showLabel && cam.zoom > 0.3) {
      const fontSize = Math.max(8, (isHovered ? 12 : 10) * Math.min(1, invZoom));
      ctx.font = `${isHovered ? "600" : "400"} ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = dimmed ? "rgba(148,163,184,0.3)" : "rgba(226,232,240,0.9)";
      ctx.textBaseline = "middle";
      const text = n.label.length > 24 ? n.label.slice(0, 22) + "..." : n.label;
      ctx.fillText(text, n.x + r + 5, n.y);
    }
  }

  ctx.restore();
}

function getFocusedGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  focusNodeId: string | undefined,
  depth: number,
) {
  if (!focusNodeId) {
    return { nodes, edges };
  }

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const focusNode = nodeMap.get(focusNodeId);
  if (!focusNode) {
    return { nodes: [], edges: [] };
  }

  const included = new Set<string>([focusNodeId]);
  let frontier = new Set<string>([focusNodeId]);
  for (let hop = 0; hop < depth; hop++) {
    const next = new Set<string>();
    for (const edge of edges) {
      if (frontier.has(edge.source) && nodeMap.has(edge.target)) {
        next.add(edge.target);
      }
      if (frontier.has(edge.target) && nodeMap.has(edge.source)) {
        next.add(edge.source);
      }
    }
    for (const id of next) included.add(id);
    frontier = next;
    if (frontier.size === 0) break;
  }

  return {
    nodes: nodes.filter((node) => included.has(node.id)),
    edges: edges.filter((edge) => included.has(edge.source) && included.has(edge.target)),
  };
}

function getGraphStats(nodes: GraphNode[], edges: GraphEdge[]) {
  const connectedIds = new Set<string>();
  for (const edge of edges) {
    connectedIds.add(edge.source);
    connectedIds.add(edge.target);
  }
  return {
    documentCount: nodes.filter((node) => node.type === "document").length,
    taskCount: nodes.filter((node) => node.type === "task").length,
    requirementCount: nodes.filter((node) => node.type === "requirement").length,
    edgeCount: edges.length,
    isolatedNodes: nodes.filter((node) => !connectedIds.has(node.id)).length,
  };
}

// ── Component ─────────────────────────────────────────────────────────────────

export function KnowledgeGraph({
  projectId,
  title = "Knowledge Graph",
  focusNodeId,
  focusDepth = 2,
  onTaskClick,
}: {
  projectId: string;
  title?: string;
  focusNodeId?: string;
  focusDepth?: 1 | 2 | 3;
  onTaskClick?: (taskId: string) => void;
}) {
  const router = useRouter();
  const { data, isLoading } = trpc.project.knowledgeGraph.useQuery({ id: projectId });
  const [localDepth, setLocalDepth] = useState<1 | 2 | 3>(focusDepth);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<{ nodes: SimNode[]; edges: SimEdge[] } | null>(null);
  const iterRef = useRef(0);
  const rafRef = useRef<number>(0);
  const [hoveredNode, setHoveredNode] = useState<SimNode | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [tooltipPos, setTooltipPos] = useState<{ left: number; top: number } | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const draggingRef = useRef<SimNode | null>(null);
  const panRef = useRef<{ startX: number; startY: number; camX: number; camY: number } | null>(null);
  const clickRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });

  const camRef = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    hoveredIdRef.current = hoveredNode?.id ?? null;
  }, [hoveredNode]);

  const visibleGraph = useMemo(() => {
    if (!data) return null;
    return getFocusedGraph(data.nodes, data.edges, focusNodeId, localDepth);
  }, [data, focusNodeId, localDepth]);

  const graphStats = useMemo(() => {
    if (!visibleGraph) return null;
    return getGraphStats(visibleGraph.nodes, visibleGraph.edges);
  }, [visibleGraph]);

  // --- resize observer ---
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const measure = (width: number) => {
      if (width > 0) {
        setDimensions({ width, height: Math.max(400, Math.min(600, width * 0.6)) });
      }
    };

    measure(container.clientWidth);

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        measure(entry.contentRect.width);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // --- simulation loop ---
  useEffect(() => {
    if (!visibleGraph || !canvasRef.current || !containerRef.current) return;

    const measured = containerRef.current.clientWidth;
    if (measured === 0) return;

    const width = measured;
    const height = Math.max(400, Math.min(600, width * 0.6));

    simRef.current = buildSimulation(visibleGraph.nodes, visibleGraph.edges);
    iterRef.current = MAX_ITERATIONS;

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      tickSimulation(simRef.current.nodes, simRef.current.edges);
    }
    camRef.current = computeFitCamera(simRef.current.nodes, width, height);

    const canvas = canvasRef.current;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let running = true;

    function loop() {
      if (!running || !simRef.current) return;

      if (iterRef.current < MAX_ITERATIONS) {
        tickSimulation(simRef.current.nodes, simRef.current.edges);
        iterRef.current++;
      }

      drawGraph(ctx!, simRef.current.nodes, simRef.current.edges, width, height, camRef.current, hoveredIdRef.current, focusNodeId, dpr);
      rafRef.current = requestAnimationFrame(loop);
    }

    loop();

    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [visibleGraph, dimensions, focusNodeId]);

  // --- hit testing in world coords ---
  const findNodeAt = useCallback((sx: number, sy: number): SimNode | null => {
    if (!simRef.current) return null;
    const { wx, wy } = screenToWorld(sx, sy, camRef.current);
    for (let i = simRef.current.nodes.length - 1; i >= 0; i--) {
      const n = simRef.current.nodes[i];
      const r = (NODE_RADII[n.type] ?? 6) + 4;
      const dx = wx - n.x;
      const dy = wy - n.y;
      if (dx * dx + dy * dy <= r * r) return n;
    }
    return null;
  }, []);

  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  // --- interactions ---

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = getCanvasCoords(e);

      if (draggingRef.current) {
        if (clickRef.current) {
          const dx = x - clickRef.current.x;
          const dy = y - clickRef.current.y;
          if (dx * dx + dy * dy > 16) clickRef.current.moved = true;
        }
        const { wx, wy } = screenToWorld(x, y, camRef.current);
        draggingRef.current.x = wx;
        draggingRef.current.y = wy;
        draggingRef.current.vx = 0;
        draggingRef.current.vy = 0;
        return;
      }

      if (panRef.current) {
        if (clickRef.current) {
          const dx = x - clickRef.current.x;
          const dy = y - clickRef.current.y;
          if (dx * dx + dy * dy > 16) clickRef.current.moved = true;
        }
        camRef.current = {
          ...camRef.current,
          x: panRef.current.camX + (x - panRef.current.startX),
          y: panRef.current.camY + (y - panRef.current.startY),
        };
        return;
      }

      const node = findNodeAt(x, y);
      setHoveredNode(node);
      if (node) {
        const cam = camRef.current;
        setTooltipPos({
          left: Math.min(node.x * cam.zoom + cam.x + 16, dimensions.width - 200),
          top: Math.min(node.y * cam.zoom + cam.y - 10, dimensions.height - 80),
        });
      } else {
        setTooltipPos(null);
      }
      if (canvasRef.current) {
        canvasRef.current.style.cursor = node ? "pointer" : "grab";
      }
    },
    [findNodeAt, getCanvasCoords, dimensions],
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const { x, y } = getCanvasCoords(e);
      clickRef.current = { x, y, moved: false };
      const node = findNodeAt(x, y);
      if (node) {
        node.pinned = true;
        draggingRef.current = node;
        setIsDragging(true);
        iterRef.current = 0;
      } else {
        panRef.current = { startX: x, startY: y, camX: camRef.current.x, camY: camRef.current.y };
        if (canvasRef.current) canvasRef.current.style.cursor = "grabbing";
      }
    },
    [findNodeAt, getCanvasCoords],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const click = clickRef.current;
      clickRef.current = null;
      if (click?.moved) return;

      const { x, y } = getCanvasCoords(e);
      const node = findNodeAt(x, y);
      if (!node) return;

      if (node.type === "document") {
        router.push(`/projects/documents/${node.id}`);
        return;
      }
      if (node.type === "requirement") {
        router.push(`/projects/${projectId}/requirements/${node.id}`);
        return;
      }
      onTaskClick?.(node.id);
    },
    [findNodeAt, getCanvasCoords, onTaskClick, projectId, router],
  );

  const handleMouseUp = useCallback(() => {
    if (draggingRef.current) {
      draggingRef.current.pinned = false;
      draggingRef.current = null;
      setIsDragging(false);
    }
    panRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = "grab";
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoveredNode(null);
    if (draggingRef.current) {
      draggingRef.current.pinned = false;
      draggingRef.current = null;
      setIsDragging(false);
    }
    panRef.current = null;
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const { x, y } = getCanvasCoords(e as unknown as React.MouseEvent<HTMLCanvasElement>);

    const cam = camRef.current;
    const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));

    // Zoom towards the cursor position
    camRef.current = {
      x: x - (x - cam.x) * (newZoom / cam.zoom),
      y: y - (y - cam.y) * (newZoom / cam.zoom),
      zoom: newZoom,
    };
    forceUpdate((n) => n + 1);
  }, [getCanvasCoords]);

  const fitToScreen = useCallback(() => {
    if (!simRef.current) return;
    camRef.current = computeFitCamera(simRef.current.nodes, dimensions.width, dimensions.height);
    forceUpdate((n) => n + 1);
  }, [dimensions]);

  const zoomBy = useCallback((factor: number) => {
    const cam = camRef.current;
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cam.zoom * factor));
    const cx = dimensions.width / 2;
    const cy = dimensions.height / 2;
    camRef.current = {
      x: cx - (cx - cam.x) * (newZoom / cam.zoom),
      y: cy - (cy - cam.y) * (newZoom / cam.zoom),
      zoom: newZoom,
    };
    forceUpdate((n) => n + 1);
  }, [dimensions]);

  // --- Loading / Empty states ---

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="h-5 w-5" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Skeleton className="h-[500px] w-full rounded-lg" />
          <div className="flex gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-28" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!data || !visibleGraph || visibleGraph.nodes.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Network className="h-5 w-5" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex h-[300px] items-center justify-center text-muted-foreground">
            No related data to visualize yet.
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            <Network className="h-5 w-5" />
            {title}
          </CardTitle>
          {focusNodeId && (
            <div className="flex items-center gap-1">
              {[1, 2, 3].map((depth) => (
                <Button
                  key={depth}
                  type="button"
                  variant={localDepth === depth ? "default" : "outline"}
                  size="xs"
                  onClick={() => setLocalDepth(depth as 1 | 2 | 3)}
                >
                  {depth} hop
                </Button>
              ))}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div
          ref={containerRef}
          className="relative w-full overflow-hidden rounded-lg border bg-slate-950"
        >
          <canvas
            ref={canvasRef}
            className="block"
            style={{ width: dimensions.width, height: dimensions.height }}
            onMouseMove={handleMouseMove}
            onMouseDown={handleMouseDown}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseLeave}
            onWheel={handleWheel}
            onClick={handleClick}
          />

          {/* Zoom controls */}
          <div className="absolute top-3 right-3 flex flex-col gap-1">
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7 bg-slate-800/80 hover:bg-slate-700 border-slate-700 text-slate-200"
              onClick={() => zoomBy(1.4)}
              title="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7 bg-slate-800/80 hover:bg-slate-700 border-slate-700 text-slate-200"
              onClick={() => zoomBy(1 / 1.4)}
              title="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="secondary"
              size="icon"
              className="h-7 w-7 bg-slate-800/80 hover:bg-slate-700 border-slate-700 text-slate-200"
              onClick={fitToScreen}
              title="Fit to screen"
            >
              <Maximize2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          {hoveredNode && !isDragging && tooltipPos && (
            <div
              className="pointer-events-none absolute z-10 max-w-xs rounded-lg border bg-popover px-3 py-2 text-sm shadow-lg"
              style={{ left: tooltipPos.left, top: tooltipPos.top }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: NODE_COLORS[hoveredNode.type] }}
                />
                <span className="font-medium capitalize">{hoveredNode.type}</span>
              </div>
              <p className="mt-1 text-foreground">{hoveredNode.label}</p>
              <p className="text-muted-foreground">
                {hoveredNode.edgeCount} connection{hoveredNode.edgeCount !== 1 ? "s" : ""}
              </p>
              {(hoveredNode.type !== "task" || onTaskClick) && (
                <p className="text-muted-foreground">Click to open</p>
              )}
            </div>
          )}

          <div className="absolute bottom-3 left-3 flex gap-3 rounded-md border border-slate-700 bg-slate-900/90 px-3 py-2 text-xs text-slate-200 shadow-md backdrop-blur-sm">
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#3b82f6]" />
              Document
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#22c55e]" />
              Task
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-[#a855f7]" />
              Requirement
            </span>
          </div>
        </div>

        <div className="flex flex-wrap gap-3">
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <FileText className="h-3.5 w-3.5 text-blue-500" />
            {graphStats?.documentCount ?? 0} Documents
          </Badge>
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <CheckSquare className="h-3.5 w-3.5 text-green-500" />
            {graphStats?.taskCount ?? 0} Tasks
          </Badge>
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <ClipboardList className="h-3.5 w-3.5 text-purple-500" />
            {graphStats?.requirementCount ?? 0} Requirements
          </Badge>
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <Link2 className="h-3.5 w-3.5" />
            {graphStats?.edgeCount ?? 0} Connections
          </Badge>
          <Badge variant="secondary" className="gap-1.5 px-3 py-1">
            <Unplug className="h-3.5 w-3.5 text-muted-foreground" />
            {graphStats?.isolatedNodes ?? 0} Isolated
          </Badge>
        </div>
      </CardContent>
    </Card>
  );
}
