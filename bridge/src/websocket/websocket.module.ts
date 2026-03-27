import { Module } from "@nestjs/common";
import { MocapGateway } from "./mocap.gateway";
import { OscModule } from "../osc/osc.module";

@Module({
  imports: [OscModule],
  providers: [MocapGateway],
})
export class WebsocketModule {}
