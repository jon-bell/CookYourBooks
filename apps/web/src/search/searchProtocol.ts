// Message contract between the main thread and `searchWorker.ts`.
//
// Lives in its own module because a `?worker` import gives back a Worker
// constructor, not the module's types — sharing the union here is what keeps
// the two sides from drifting.

/** Requests: main thread → worker. Every one carries a correlation `id`. */
export type SearchWorkerRequest =
  | { type: 'load'; id: number }
  | { type: 'hydrate'; id: number; ids: string[]; vectors: Float32Array; count: number }
  | { type: 'embed'; id: number; text: string }
  | { type: 'query'; id: number; text: string; limit: number };

/** Responses: worker → main thread. `id` echoes the request. */
export type SearchWorkerResponse =
  | { type: 'loaded'; id: number }
  | { type: 'hydrated'; id: number; count: number }
  | { type: 'embedded'; id: number; vector: Float32Array }
  | {
      type: 'result';
      id: number;
      /** Top hits by cosine, descending. At most the requested `limit`. */
      recipeIds: string[];
      scores: number[];
      /** How many vectors the cosine pass actually scanned. */
      scanned: number;
      /** Split so the perf breakdown can separate inference from scan. */
      embedMs: number;
      scoreMs: number;
    }
  | { type: 'error'; id: number; message: string };

/** Narrowing helper: the response type produced by a given request type. */
export type ResponseFor<T extends SearchWorkerRequest['type']> = Extract<
  SearchWorkerResponse,
  {
    type: T extends 'load'
      ? 'loaded'
      : T extends 'hydrate'
        ? 'hydrated'
        : T extends 'embed'
          ? 'embedded'
          : 'result';
  }
>;
