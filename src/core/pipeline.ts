// push/pull PIPELINE — the nng push/pull pattern. A pool of N workers PULL from a shared task queue
// (load-balanced fan-out); each processes a task and emits a result. Completion order is non-deterministic but
// the result set is complete and index-aligned to the input. For our RLM labeling map-reduce, the partitions
// are tasks and the labeler agents are the pool — no central bottleneck, work is balanced by who pulls next.
// In a real deployment the queue is a quack table / ducknng pull socket and the workers are separate processes.

/** Run `tasks` through a pool of at most `concurrency` workers pulling from a shared cursor. Results are returned
 *  in INPUT order regardless of completion order. */
export async function runPipeline<T, R>(tasks: readonly T[], worker: (task: T, index: number) => Promise<R>, concurrency: number): Promise<R[]> {
  const results = new Array<R>(tasks.length);
  let cursor = 0;
  const pull = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= tasks.length) return;
      results[i] = await worker(tasks[i]!, i);
    }
  };
  const lanes = Math.max(1, Math.min(concurrency, tasks.length));
  await Promise.all(Array.from({ length: lanes }, () => pull()));
  return results;
}
