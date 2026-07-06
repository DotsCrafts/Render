/**
 * Dispatch lanes — per-session FIFO with a global exclusive lane.
 *
 * The bridge originally dispatched every command through ONE global FIFO: safe
 * (the root fix for the M2 burst wedge) but a waterfall — one session's slow
 * navigate stalled every other session's commands (audited finding
 * "ux-data-fifo-waterfall"). With leases partitioned per session, commands from
 * DIFFERENT sessions no longer share lease state, so they may run concurrently;
 * within a session, order still matters (navigate → exec → exec), so each lane
 * stays FIFO.
 *
 * Lease-MUTATING ops (`tabs new/select/close`, `close-window`) still take a
 * global exclusive lane: they create/destroy real views through the shared
 * Electron TabManager, which is the state whose concurrent mutation caused the
 * original wedge. An exclusive op is a barrier — it waits for every in-flight
 * lane to drain, runs alone, and later work (any lane) waits for it.
 */

export interface DispatchLanes {
  /**
   * Queue `run`. Non-exclusive: FIFO within `laneKey`, concurrent across lanes,
   * but always AFTER the last exclusive op. Exclusive: waits for every pending
   * lane + the last exclusive op, then runs as a barrier. Returns `run`'s own
   * settlement (a rejection never wedges the lane).
   */
  enqueue<T>(laneKey: string, exclusive: boolean, run: () => Promise<T>): Promise<T>;
}

export function createDispatchLanes(): DispatchLanes {
  // Settled-tail promises only (never rejected), so chaining can't double-report.
  const lanes = new Map<string, Promise<unknown>>();
  let exclusiveTail: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(laneKey: string, exclusive: boolean, run: () => Promise<T>): Promise<T> => {
    const prior = exclusive
      ? Promise.allSettled([exclusiveTail, ...lanes.values()])
      : Promise.allSettled([exclusiveTail, lanes.get(laneKey) ?? Promise.resolve()]);
    const queued = prior.then(run);
    const tail = queued.then(
      () => undefined,
      () => undefined,
    );
    if (exclusive) {
      exclusiveTail = tail;
      // Every lane's pending work is already folded into the barrier; later
      // lane commands wait on exclusiveTail anyway, so drop the entries to
      // keep the map from growing one key per finished session.
      lanes.clear();
    } else {
      lanes.set(laneKey, tail);
      void tail.then(() => {
        if (lanes.get(laneKey) === tail) lanes.delete(laneKey);
      });
    }
    return queued;
  };

  return { enqueue };
}
