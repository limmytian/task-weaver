"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { GitBranch, Link2, Maximize2, MoveRight, ZoomIn, ZoomOut } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type DependencyDagNode = {
  id: string;
  title: string;
  status: string;
  priority?: string | null;
  href?: string;
  external?: boolean;
  meta?: string | null;
};

export type DependencyDagEdge = {
  id: string;
  source: string;
  target: string;
  type: "blocks" | "related" | string;
};

type LayoutNode = DependencyDagNode & {
  x: number;
  y: number;
  layer: number;
};

const NODE_W = 232;
const NODE_H = 82;
const COL_GAP = 72;
const ROW_GAP = 28;
const PAD = 18;
const MIN_ZOOM = 0.04;
const MAX_ZOOM = 2.4;

const statusClasses: Record<string, string> = {
  draft: "border-slate-300 bg-slate-50 text-slate-700 dark:bg-slate-900/40",
  approved: "border-sky-300 bg-sky-50 text-sky-700 dark:bg-sky-950/40",
  todo: "border-slate-300 bg-slate-50 text-slate-700 dark:bg-slate-900/40",
  in_progress: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40",
  in_review: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-800 dark:bg-fuchsia-950/40",
  ready_to_merge: "border-cyan-300 bg-cyan-50 text-cyan-800 dark:bg-cyan-950/40",
  done: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40",
  cancelled: "border-destructive/40 bg-destructive/10 text-destructive",
  archived: "border-muted bg-muted/50 text-muted-foreground",
};

const statusBadgeClasses: Record<string, string> = {
  draft: "border-slate-300 bg-slate-50 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
  approved: "border-sky-300 bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  todo: "border-slate-300 bg-slate-50 text-slate-700 dark:bg-slate-900/40 dark:text-slate-300",
  in_progress: "border-amber-300 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300",
  in_review: "border-fuchsia-300 bg-fuchsia-50 text-fuchsia-800 dark:bg-fuchsia-950/40 dark:text-fuchsia-300",
  ready_to_merge: "border-cyan-300 bg-cyan-50 text-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-300",
  done: "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300",
  cancelled: "border-destructive/40 bg-destructive/10 text-destructive",
  archived: "border-muted bg-muted/50 text-muted-foreground",
};

const statusLabels: Record<string, string> = {
  draft: "Draft",
  approved: "Approved",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  ready_to_merge: "Ready to Merge",
  done: "Done",
  cancelled: "Cancelled",
  archived: "Archived",
};

function layoutDag(nodes: DependencyDagNode[], edges: DependencyDagEdge[]) {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }

  for (const edge of edges) {
    if (!nodeMap.has(edge.source) || !nodeMap.has(edge.target)) continue;
    incoming.get(edge.target)?.push(edge.source);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const indegree = new Map(nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]));
  const queue = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .sort((a, b) => a.title.localeCompare(b.title));
  const layer = new Map(nodes.map((node) => [node.id, 0]));
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    visited.add(current.id);
    for (const nextId of outgoing.get(current.id) ?? []) {
      layer.set(nextId, Math.max(layer.get(nextId) ?? 0, (layer.get(current.id) ?? 0) + 1));
      indegree.set(nextId, (indegree.get(nextId) ?? 0) - 1);
      if ((indegree.get(nextId) ?? 0) === 0) {
        const next = nodeMap.get(nextId);
        if (next) queue.push(next);
      }
    }
    queue.sort((a, b) => a.title.localeCompare(b.title));
  }

  for (const node of nodes) {
    if (!visited.has(node.id)) {
      const fallbackLayer = Math.max(0, ...Array.from(layer.values())) + 1;
      layer.set(node.id, fallbackLayer);
    }
  }

  const byLayer = new Map<number, DependencyDagNode[]>();
  for (const node of nodes) {
    const nodeLayer = layer.get(node.id) ?? 0;
    const list = byLayer.get(nodeLayer) ?? [];
    list.push(node);
    byLayer.set(nodeLayer, list);
  }

  const layoutNodes: LayoutNode[] = [];
  for (const [nodeLayer, list] of byLayer) {
    list.sort((a, b) => {
      const statusDiff = a.status.localeCompare(b.status);
      return statusDiff !== 0 ? statusDiff : a.title.localeCompare(b.title);
    });
    list.forEach((node, index) => {
      layoutNodes.push({
        ...node,
        layer: nodeLayer,
        x: PAD + nodeLayer * (NODE_W + COL_GAP),
        y: PAD + index * (NODE_H + ROW_GAP),
      });
    });
  }

  const maxLayer = Math.max(0, ...layoutNodes.map((node) => node.layer));
  const maxRows = Math.max(1, ...Array.from(byLayer.values()).map((list) => list.length));

  return {
    nodes: layoutNodes,
    width: PAD * 2 + (maxLayer + 1) * NODE_W + maxLayer * COL_GAP,
    height: PAD * 2 + maxRows * NODE_H + (maxRows - 1) * ROW_GAP,
  };
}

function edgePath(source: LayoutNode, target: LayoutNode) {
  const sx = source.x + NODE_W;
  const sy = source.y + NODE_H / 2;
  const tx = target.x;
  const ty = target.y + NODE_H / 2;
  const mid = Math.max(28, Math.abs(tx - sx) / 2);
  return `M ${sx} ${sy} C ${sx + mid} ${sy}, ${tx - mid} ${ty}, ${tx} ${ty}`;
}

function NodeContent({ node }: { node: DependencyDagNode }) {
  return (
    <>
      <div className="flex items-start gap-2">
        <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="line-clamp-2 text-sm font-medium leading-snug">{node.title}</p>
          {node.meta && (
            <p className="mt-1 truncate text-[11px] text-muted-foreground">{node.meta}</p>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <Badge
          variant="outline"
          className={cn("max-w-[118px] truncate text-[10px]", statusBadgeClasses[node.status])}
        >
          {statusLabels[node.status] ?? node.status}
        </Badge>
        {node.priority && (
          <Badge variant="secondary" className="max-w-[82px] truncate text-[10px]">
            {node.priority}
          </Badge>
        )}
        {node.external && (
          <Badge variant="outline" className="ml-auto text-[10px]">
            external
          </Badge>
        )}
      </div>
    </>
  );
}

export function DependencyDag({
  nodes,
  edges,
  isLoading,
  emptyLabel = "No dependency graph yet.",
  onNodeClick,
}: {
  nodes?: DependencyDagNode[];
  edges?: DependencyDagEdge[];
  isLoading?: boolean;
  emptyLabel?: string;
  onNodeClick?: (node: DependencyDagNode) => void;
}) {
  const graphNodes = useMemo(() => nodes ?? [], [nodes]);
  const graphEdges = useMemo(() => edges ?? [], [edges]);
  const layout = useMemo(
    () => graphNodes.length > 0
      ? layoutDag(graphNodes, graphEdges)
      : { nodes: [] as LayoutNode[], width: 0, height: 0 },
    [graphEdges, graphNodes],
  );
  const layoutById = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout.nodes],
  );
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const contentWidth = Math.max(layout.width, 680);
  const contentHeight = Math.max(layout.height, 280);

  const fitToView = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || contentWidth === 0 || contentHeight === 0) return;
    const width = viewport.clientWidth;
    const height = viewport.clientHeight;
    const availableWidth = Math.max(1, width - 36);
    const availableHeight = Math.max(1, height - 36);
    const nextZoom = Math.min(
      1,
      Math.max(
        MIN_ZOOM,
        Math.min(availableWidth / contentWidth, availableHeight / contentHeight),
      ),
    );
    setZoom(nextZoom);
    setPan({
      x: Math.max(18, (width - contentWidth * nextZoom) / 2),
      y: Math.max(18, (height - contentHeight * nextZoom) / 2),
    });
  }, [contentHeight, contentWidth]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      fitToView();
      return;
    }

    let frame = 0;
    const scheduleFit = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fitToView);
    };

    scheduleFit();

    if (typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(frame);
    }

    const observer = new ResizeObserver(scheduleFit);
    observer.observe(viewport);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [fitToView]);

  const connectedNodeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    const ids = new Set<string>([hoveredNodeId]);
    for (const edge of graphEdges) {
      if (edge.source === hoveredNodeId) ids.add(edge.target);
      if (edge.target === hoveredNodeId) ids.add(edge.source);
    }
    return ids;
  }, [graphEdges, hoveredNodeId]);

  const connectedEdgeIds = useMemo(() => {
    if (!hoveredNodeId) return new Set<string>();
    return new Set(
      graphEdges
        .filter((edge) => edge.source === hoveredNodeId || edge.target === hoveredNodeId)
        .map((edge) => edge.id),
    );
  }, [graphEdges, hoveredNodeId]);

  const zoomBy = (factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    setZoom((currentZoom) => {
      const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, currentZoom * factor));
      setPan((currentPan) => {
        const wx = (cx - currentPan.x) / currentZoom;
        const wy = (cy - currentPan.y) / currentZoom;
        return {
          x: cx - wx * nextZoom,
          y: cy - wy * nextZoom,
        };
      });
      return nextZoom;
    });
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    setZoom((currentZoom) => {
      const nextZoom = Math.min(
        MAX_ZOOM,
        Math.max(MIN_ZOOM, currentZoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12)),
      );
      setPan((currentPan) => {
        const wx = (x - currentPan.x) / currentZoom;
        const wy = (y - currentPan.y) / currentZoom;
        return {
          x: x - wx * nextZoom,
          y: y - wy * nextZoom,
        };
      });
      return nextZoom;
    });
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("[data-dag-node='true']")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      panX: pan.x,
      panY: pan.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsPanning(true);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setPan({
      x: drag.panX + event.clientX - drag.startX,
      y: drag.panY + event.clientY - drag.startY,
    });
  };

  const stopPan = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setIsPanning(false);
  };

  if (isLoading) {
    return <Skeleton className="h-[360px] rounded-lg" />;
  }

  if (graphNodes.length === 0) {
    return (
      <div className="flex h-48 flex-col items-center justify-center rounded-lg border border-dashed text-center">
        <GitBranch className="mb-2 h-8 w-8 text-muted-foreground/40" />
        <p className="text-sm text-muted-foreground">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      className={cn(
        "relative h-[calc(100svh-220px)] min-h-[320px] w-full overflow-hidden rounded-lg border bg-background",
        isPanning ? "cursor-grabbing" : "cursor-grab",
      )}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={stopPan}
      onPointerCancel={stopPan}
    >
      <div className="absolute right-3 top-3 z-20 flex gap-1 rounded-md border bg-background/90 p-1 shadow-sm">
        <Button variant="ghost" size="icon-xs" onClick={() => zoomBy(1.2)} title="Zoom in">
          <ZoomIn className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => zoomBy(1 / 1.2)} title="Zoom out">
          <ZoomOut className="h-3.5 w-3.5" />
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={fitToView} title="Fit to view">
          <Maximize2 className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div
        className="relative"
        style={{
          width: contentWidth,
          height: contentHeight,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transformOrigin: "0 0",
        }}
      >
        <svg
          className="absolute inset-0 h-full w-full"
          width={contentWidth}
          height={contentHeight}
        >
          <defs>
            <marker
              id="dependency-arrow"
              markerWidth="8"
              markerHeight="8"
              refX="7"
              refY="4"
              orient="auto"
              markerUnits="strokeWidth"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" className="fill-muted-foreground" />
            </marker>
          </defs>
          {graphEdges.map((edge) => {
            const source = layoutById.get(edge.source);
            const target = layoutById.get(edge.target);
            if (!source || !target) return null;
            const isHighlighted = connectedEdgeIds.has(edge.id);
            const isDimmed = hoveredNodeId != null && !isHighlighted;
            return (
              <g key={edge.id}>
                <path
                  d={edgePath(source, target)}
                  className={cn(
                    "fill-none stroke-muted-foreground/45 transition-opacity",
                    edge.type === "related" && "stroke-muted-foreground/30",
                    isHighlighted && "stroke-primary opacity-100",
                    isDimmed && "opacity-15",
                  )}
                  strokeWidth={isHighlighted ? 2.6 : edge.type === "blocks" ? 1.8 : 1.2}
                  strokeDasharray={edge.type === "related" ? "5 5" : undefined}
                  markerEnd="url(#dependency-arrow)"
                />
                {edge.type === "related" && !isDimmed && (
                  <Link2 className="text-muted-foreground/50" x={(source.x + target.x + NODE_W) / 2} y={(source.y + target.y + NODE_H) / 2 - 7} size={14} />
                )}
              </g>
            );
          })}
        </svg>

        {layout.nodes.map((node) => {
          const isConnected = hoveredNodeId == null || connectedNodeIds.has(node.id);
          const className = cn(
            "absolute h-[82px] w-[232px] cursor-pointer rounded-md border bg-card p-3 shadow-sm transition-all",
            statusClasses[node.status] ?? "border-border",
            node.external && "border-dashed opacity-80",
            node.href && "hover:bg-accent",
            onNodeClick && "hover:bg-accent",
            hoveredNodeId === node.id && "ring-2 ring-primary/40",
            !isConnected && "opacity-30",
          );
          const style = { left: node.x, top: node.y };
          const nodeProps = {
            "data-dag-node": "true",
            onMouseEnter: () => setHoveredNodeId(node.id),
            onMouseLeave: () => setHoveredNodeId(null),
            onFocus: () => setHoveredNodeId(node.id),
            onBlur: () => setHoveredNodeId(null),
          };

          if (node.href) {
            return (
              <Link key={node.id} href={node.href} className={className} style={style} {...nodeProps}>
                <NodeContent node={node} />
              </Link>
            );
          }

          if (onNodeClick) {
            return (
              <button
                key={node.id}
                type="button"
                className={cn(className, "text-left")}
                style={style}
                onClick={() => onNodeClick(node)}
                {...nodeProps}
              >
                <NodeContent node={node} />
              </button>
            );
          }

          return (
            <div key={node.id} className={className} style={style} {...nodeProps}>
              <NodeContent node={node} />
            </div>
          );
        })}

        {graphEdges.length === 0 && (
          <div className="absolute bottom-3 left-3 flex items-center gap-1.5 rounded-md border bg-background/90 px-2 py-1 text-xs text-muted-foreground">
            <MoveRight className="h-3.5 w-3.5" />
            No explicit dependencies
          </div>
        )}
      </div>
      <div className="absolute bottom-3 right-3 rounded-md border bg-background/90 px-2 py-1 text-[10px] text-muted-foreground shadow-sm">
        {Math.round(zoom * 100)}%
      </div>
    </div>
  );
}
