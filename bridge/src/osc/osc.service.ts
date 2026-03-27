import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as osc from "osc";
import { buildVmcMessages } from "./vmc-builder";
import type { MocapFrame } from "@onapose/shared";

@Injectable()
export class OscService implements OnModuleInit, OnModuleDestroy {
  private udpPort: osc.UDPPort | null = null;
  private targetHost: string;
  private targetPort: number;

  constructor(private readonly config: ConfigService) {
    this.targetHost = this.config.get<string>("OSC_TARGET_HOST", "127.0.0.1");
    this.targetPort = this.config.get<number>("OSC_TARGET_PORT", 39539);
  }

  onModuleInit() {
    this.udpPort = new osc.UDPPort({
      localAddress: "0.0.0.0",
      localPort: 0, // OS assigns an ephemeral port for sending
      remoteAddress: this.targetHost,
      remotePort: this.targetPort,
      metadata: true,
    });

    this.udpPort.on("error", (err: Error) => {
      console.error("[osc] UDP error:", err.message);
    });

    this.udpPort.open();
    console.log(`[osc] UDP sender ready -> ${this.targetHost}:${this.targetPort}`);
  }

  onModuleDestroy() {
    this.udpPort?.close();
  }

  sendFrame(frame: MocapFrame): void {
    if (!this.udpPort) return;

    const messages = buildVmcMessages(frame);
    for (const msg of messages) {
      this.udpPort.send(msg);
    }
  }
}
