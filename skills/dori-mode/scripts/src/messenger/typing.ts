export type Timers = { readonly setInterval: (cb: () => void, ms: number) => unknown; readonly clearInterval: (h: unknown) => void };

export const realTimers: Timers = { setInterval: (cb, ms) => setInterval(cb, ms), clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>) };
