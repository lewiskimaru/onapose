declare module "osc" {
  interface UDPPortOptions {
    localAddress?: string;
    localPort?: number;
    remoteAddress?: string;
    remotePort?: number;
    metadata?: boolean;
  }

  interface OscArg {
    type: string;
    value: number | string;
  }

  interface OscMessage {
    address: string;
    args: OscArg[];
  }

  class UDPPort {
    constructor(options: UDPPortOptions);
    on(event: "error", handler: (err: Error) => void): void;
    on(event: string, handler: (...args: unknown[]) => void): void;
    open(): void;
    close(): void;
    send(message: OscMessage): void;
  }
}
