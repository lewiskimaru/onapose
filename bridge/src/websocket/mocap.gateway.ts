import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
} from "@nestjs/websockets";
import { Server, Socket } from "socket.io";
import { OscService } from "../osc/osc.service";
import type { MocapFrame } from "@onapose/shared";

@WebSocketGateway(8080, {
  cors: { origin: "*" },
  transports: ["websocket"],
})
export class MocapGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  constructor(private readonly oscService: OscService) {}

  handleConnection(client: Socket) {
    console.log(`[ws] client connected: ${client.id}`);
  }

  handleDisconnect(client: Socket) {
    console.log(`[ws] client disconnected: ${client.id}`);
  }

  @SubscribeMessage("mocap_frame")
  handleFrame(@MessageBody() frame: MocapFrame): void {
    this.oscService.sendFrame(frame);
  }
}
