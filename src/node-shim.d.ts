type Buffer = Uint8Array;

declare module "events" {
  class EventEmitter {
    on(event: string, listener: (...args: any[]) => void): this;
  }

  export { EventEmitter };
}

declare module "stream" {
  import type { EventEmitter } from "events";

  class Readable extends EventEmitter {
    pipe(destination: any): any;
    on(event: string, listener: (chunk: any) => void): this;
  }

  export { Readable };
}

declare module "child_process" {
  import type { EventEmitter } from "events";
  import type { Readable } from "stream";

  interface ChildProcessWithoutNullStreams extends EventEmitter {
    stdout: Readable;
    stderr: Readable;
    on(event: "close", listener: (code: number | null) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
  }

  function spawn(
    command: string,
    args?: ReadonlyArray<string>,
    options?: Record<string, unknown>
  ): ChildProcessWithoutNullStreams;

  export { spawn, ChildProcessWithoutNullStreams };
}
