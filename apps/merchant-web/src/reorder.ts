import { useRef, type PointerEvent as ReactPointerEvent } from "react";

/** The list with the entry at `from` moved to `to` (both clamped); the same list when unchanged. */
export function moveTo<T>(list: readonly T[], from: number, to: number): readonly T[] {
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (from < 0 || from >= list.length || target === from) return list;
  const next = [...list];
  const [entry] = next.splice(from, 1);
  next.splice(target, 0, entry as T);
  return next;
}

/**
 * Where a row dragged from `from` lands when the pointer is at `y`: the number of the other rows
 * whose vertical middle is above the pointer, which is its index once it is moved there.
 */
export function dropIndex(y: number, middles: readonly number[], from: number): number {
  return middles.filter((middle, index) => index !== from && middle < y).length;
}

/**
 * WP-2423 Q32: drag a row by its handle, with a mouse, pen or finger. Each list has a key; its rows
 * register with `row(list, i)` and their handles get `handle(list, i)`. The move is applied once,
 * when the pointer is released. Keyboard and screen-reader users keep the Move buttons.
 */
export function useDragReorder(onMove: (list: string, from: number, to: number) => void) {
  const lists = useRef(new Map<string, (HTMLElement | null)[]>());
  const drag = useRef<{ list: string; from: number; pointer: number } | null>(null);
  const rowsOf = (list: string) => lists.current.get(list) ?? [];
  const middles = (list: string) =>
    rowsOf(list).map((element) => {
      const box = element?.getBoundingClientRect();
      return box ? box.top + box.height / 2 : Number.POSITIVE_INFINITY;
    });
  const mark = (list: string, to: number | null) =>
    rowsOf(list).forEach((element, index) => {
      if (!element) return;
      if (to === index) element.dataset.dropTarget = "true";
      else delete element.dataset.dropTarget;
    });
  return {
    row: (list: string, index: number) => (element: HTMLElement | null) => {
      const rows = lists.current.get(list) ?? [];
      rows[index] = element;
      lists.current.set(list, rows);
    },
    handle: (list: string, index: number) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { list, from: index, pointer: event.pointerId };
        mark(list, index);
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        if (drag.current?.pointer !== event.pointerId) return;
        mark(list, dropIndex(event.clientY, middles(list), drag.current.from));
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const current = drag.current;
        if (current?.pointer !== event.pointerId) return;
        drag.current = null;
        mark(list, null);
        const to = dropIndex(event.clientY, middles(list), current.from);
        if (to !== current.from) onMove(list, current.from, to);
      },
      onPointerCancel: () => {
        drag.current = null;
        mark(list, null);
      },
    }),
  };
}
