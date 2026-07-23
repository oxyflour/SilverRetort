import { useEffect, useRef, useState } from "react";
import RoutingWorker from "../../circuit-ui/src/routing.worker.ts?worker&inline";
import { buildRoutes } from "../../circuit-ui/src/routing";
import type { CircuitData, Point, RoutedLink } from "../../circuit-ui/src/types";

interface WorkerState {
  isCalculating: boolean;
  routes: RoutedLink[];
}

interface WorkerMessage {
  id: number;
  routes: RoutedLink[];
}

export function useRoutingWorker(
  data: CircuitData,
  positions: Record<string, Point>,
  skip = false,
): WorkerState {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const pendingRef = useRef(new Set<number>());
  const lastValidRoutesRef = useRef<RoutedLink[]>([]);
  const [state, setState] = useState<WorkerState>({ routes: [], isCalculating: false });

  useEffect(() => {
    const worker = new RoutingWorker();
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const { id, routes } = event.data;
      pendingRef.current.delete(id);
      lastValidRoutesRef.current = routes;
      setState({ routes, isCalculating: pendingRef.current.size > 0 });
    };
    worker.onerror = (error) => {
      console.error("Routing worker error:", error);
      setState({ routes: lastValidRoutesRef.current, isCalculating: false });
    };
    return () => {
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (skip) return;
    const worker = workerRef.current;
    if (!worker) {
      const routes = buildRoutes(data, positions);
      lastValidRoutesRef.current = routes;
      setState({ routes, isCalculating: false });
      return;
    }

    const id = ++requestIdRef.current;
    pendingRef.current.add(id);
    const timer = window.setTimeout(() => {
      worker.postMessage({ id, type: "buildRoutes", data, positions });
    }, 16);
    setState((previous) => ({ ...previous, isCalculating: true }));

    return () => {
      window.clearTimeout(timer);
      pendingRef.current.delete(id);
    };
  }, [data, positions, skip]);

  return state;
}
