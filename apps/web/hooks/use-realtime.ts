"use client";

import { useEffect, useRef, useState } from "react";
import { acceptRealtimeSequence } from "@task-weaver/realtime/sequence";
import { trpc } from "@/trpc/client";

type ConnectionState = "connecting" | "live" | "reconnecting" | "stale";

/**
 * Connect to the realtime stream and coalesce high-frequency daemon updates.
 * The returned state lets operator surfaces distinguish live/stale data.
 */
export function useRealtime() {
  const utils = trpc.useUtils();
  const retryRef = useRef(0);
  const lastEventIdRef = useRef<string | null>(null);
  const lastSequenceRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    const scheduleDaemonRefresh = () => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = setTimeout(() => {
        refreshTimerRef.current = null;
        utils.daemon.list.invalidate();
        utils.daemon.queues.invalidate();
        utils.daemon.overview.invalidate();
        utils.daemon.metrics.invalidate();
        utils.daemon.timeline.invalidate();
      }, 100);
    };

    const acceptEvent = (event: MessageEvent) => {
      if (event.lastEventId) lastEventIdRef.current = event.lastEventId;
      try {
        const data = JSON.parse(event.data) as { sequence?: unknown };
        if (typeof data.sequence !== "number") return { data, missed: false };
        const decision = acceptRealtimeSequence(lastSequenceRef.current, data.sequence);
        if (!decision.accepted) return null;
        lastSequenceRef.current = data.sequence;
        return { data, missed: decision.missed };
      } catch {
        return null;
      }
    };

    const connect = () => {
      if (closed) return;
      setConnectionState(retryRef.current > 0 ? "reconnecting" : "connecting");
      const after = lastEventIdRef.current
        ? `?after=${encodeURIComponent(lastEventIdRef.current)}`
        : "";
      es = new EventSource(`/api/events${after}`);

      es.addEventListener("connected", (event: MessageEvent) => {
        retryRef.current = 0;
        setConnectionState("live");
        try {
          const data = JSON.parse(event.data) as { lastEventId?: string | null };
          if (data.lastEventId) lastEventIdRef.current = data.lastEventId;
        } catch {
          // Legacy connected payloads are intentionally ignored.
        }
      });

      for (const evt of ["task_created", "task_updated", "task_status_changed", "task_commented", "task_deleted"]) {
        es.addEventListener(evt, (event: MessageEvent) => {
          const accepted = acceptEvent(event);
          if (!accepted) return;
          const data = accepted.data as { projectId?: string; taskId?: string };
          if (data.projectId) {
            utils.task.board.invalidate({ projectId: data.projectId });
            utils.task.list.invalidate({ projectId: data.projectId });
          }
          if (data.taskId) utils.task.get.invalidate({ id: data.taskId });
          scheduleDaemonRefresh();
          utils.activity.list.invalidate();
        });
      }

      for (const evt of ["document_created", "document_updated", "document_deleted", "document_linked", "document_unlinked", "document_task_linked", "document_task_unlinked"]) {
        es.addEventListener(evt, (event: MessageEvent) => {
          const accepted = acceptEvent(event);
          if (!accepted) return;
          const data = accepted.data as { documentId?: string };
          utils.document.list.invalidate();
          if (data.documentId) utils.document.get.invalidate({ id: data.documentId });
          utils.activity.list.invalidate();
        });
      }

      for (const evt of ["requirement_created", "requirement_updated", "requirement_deleted", "repository_retry_requested"]) {
        es.addEventListener(evt, (event: MessageEvent) => {
          const accepted = acceptEvent(event);
          if (!accepted) return;
          const data = accepted.data as { projectId?: string; requirementId?: string };
          if (data.projectId) utils.requirement.list.invalidate({ projectId: data.projectId });
          if (data.requirementId) utils.requirement.get.invalidate({ id: data.requirementId });
          scheduleDaemonRefresh();
          utils.activity.list.invalidate();
        });
      }

      es.addEventListener("daemon_status_changed", (event: MessageEvent) => {
        if (acceptEvent(event)) scheduleDaemonRefresh();
      });
      es.addEventListener("daemon_progress_updated", (event: MessageEvent) => {
        const accepted = acceptEvent(event);
        if (!accepted) return;
        // Missed sequences trigger the same bounded consistency refresh; a
        // normal burst is coalesced to one invalidation window.
        scheduleDaemonRefresh();
      });

      es.onerror = () => {
        es?.close();
        setConnectionState("stale");
        const delay = Math.min(1000 * Math.pow(2, retryRef.current), 30_000);
        retryRef.current++;
        setTimeout(connect, delay);
      };
    };

    connect();
    const consistencyRefresh = setInterval(scheduleDaemonRefresh, 30_000);
    return () => {
      closed = true;
      es?.close();
      clearInterval(consistencyRefresh);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, [utils]);

  return { connectionState };
}
