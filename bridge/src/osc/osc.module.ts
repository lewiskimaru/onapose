import { Module } from "@nestjs/common";
import { OscService } from "./osc.service";

@Module({
  providers: [OscService],
  exports: [OscService],
})
export class OscModule {}
