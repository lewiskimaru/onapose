import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ["log", "warn", "error"],
  });

  // The WebSocket gateway binds its own port — HTTP server port is unused
  // but NestJS requires it to start. We use a high port to avoid conflicts.
  await app.listen(3001);
  console.log("[bridge] started — WebSocket gateway listening on ws://localhost:8080");
}

bootstrap();
