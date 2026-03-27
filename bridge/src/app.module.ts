import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { WebsocketModule } from "./websocket/websocket.module";
import { OscModule } from "./osc/osc.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    OscModule,
    WebsocketModule,
  ],
})
export class AppModule {}
