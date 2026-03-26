import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger, LogLevel } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';
import { validateEnv } from './config/env.validation';
import { GlobalExceptionFilter } from './common/filters';
import { TransformInterceptor, LoggingInterceptor, TimeoutInterceptor } from './common/interceptors';
import { AppConfigService } from './config/app.config';

async function bootstrap() {
  const env = validateEnv();

  const app = await NestFactory.create(AppModule, {
    logger: (['error', 'warn', 'log', 'debug'] as LogLevel[]).slice(
      0,
      ['error', 'warn', 'log', 'debug'].indexOf(env.LOG_LEVEL) + 1,
    ),
  });

  const configService = app.get(AppConfigService);

  // Global prefix
  app.setGlobalPrefix(configService.apiPrefix, {
    exclude: ['/health', '/health/ready'],
  });

  // Security
  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());
  const allowedOrigins = configService.webUrl
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, server-to-server, health checks)
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Correlation-ID'],
  });

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  // Global interceptors
  app.useGlobalInterceptors(
    new LoggingInterceptor(),
    new TransformInterceptor(),
    new TimeoutInterceptor(),
  );

  // Global exception filter
  app.useGlobalFilters(new GlobalExceptionFilter(configService));

  // Swagger (development only)
  if (configService.isDevelopment) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('Zentik API')
      .setDescription('Zentik — Enterprise Project Management Platform API')
      .setVersion('1.0')
      .addCookieAuth('session')
      .addServer(`http://localhost:${configService.port}`)
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api/docs', app, document);
  }

  await app.listen(configService.port);

  const logger = new Logger('Bootstrap');
  logger.log(`Zentik API running on http://localhost:${configService.port}`);
  logger.log(`Environment: ${configService.nodeEnv}`);
  if (configService.isDevelopment) {
    logger.log(`Swagger: http://localhost:${configService.port}/api/docs`);
  }
}

bootstrap();
