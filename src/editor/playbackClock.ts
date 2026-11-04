/** The player clock updates independently of the project, inspectors and clip cards. */
export type PlaybackClock = ReturnType<typeof createPlaybackClock>;

export const createPlaybackClock = () => {
  let frame = 0;
  const listeners = new Set<() => void>();
  return {
    getFrame: () => frame,
    setFrame: (next: number) => {
      if (!Number.isFinite(next)) return;
      next = Math.max(0, Math.round(next));
      if (frame === next) return;
      frame = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};
