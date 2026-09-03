import dotenv from 'dotenv';
import { startEventsServer } from './api/events-server';
import { EventSubscriber } from './services/event-subscriber';
import { NotificationScheduler } from './services/notification-scheduler';
import { RetryScheduler } from './services/retry-scheduler';
import { ScheduledNotificationRepository } from './services/scheduled-notification-repository';
import { NotificationTemplateRepository } from './services/notification-template-repository';
import { NotificationTemplateService } from './services/notification-template-service';
import { TemplateAuditTrail } from './services/template-audit-trail';
import { getTemplateCache } from './services/notification-template-cache';
import { NotificationAPI } from './services/notification-api';
import { CleanupService } from './services/cleanup-service';
import { ArchiveService } from './services/archive-service';
import { ArchiveStore } from './services/archive-store';
import { loadArchiveConfig } from './services/archive-config';
import { initializeDatabase } from './database/database';
import { DiscordNotificationService } from './services/discord-notification';
import { TemplateService } from './services/template-service';
import { TemplateRepository } from './services/template-repository';
import {
  IndexingReconciliationEngine,
  createDefaultAlertSink,
} from './services/indexing-reconciliation-engine';
import { initNotificationAnalyticsAggregator } from './services/notification-analytics-aggregator';
import { NotificationMetricsStore } from './services/notification-metrics-store';
import { NotificationMetricsRunner } from './services/notification-metrics-runner';
import { eventRegistry } from './store/event-registry';
import logger from './utils/logger';
import { loadConfig, validateConfig, ConfigError } from './config';
import { SecretValidationError } from './config/validate-secrets';
import { NotificationHealthMonitor } from './services/notification-health-monitor';
import { getWorkerManager } from './services/worker-manager';
import { EventDeduplicationService } from './services/event-deduplication-service';

dotenv.config();

// Track process startup time for uptime calculation
const PROCESS_START_TIME = Date.now();

async function main() {
  const config = loadConfig();
  validateConfig(config);

  let scheduler: NotificationScheduler | null = null;
  let retryScheduler: RetryScheduler | null = null;
  let notificationAPI: NotificationAPI | null = null;
  let healthMonitor: NotificationHealthMonitor | null = null;
  let subscriber: EventSubscriber | null = null;

  let templateService: NotificationTemplateService | null = null;
  let legacyTemplateService: TemplateService | null = null;
  let cleanupService: CleanupService | null = null;
  let repository: ScheduledNotificationRepository | null = null;
  let reconciliationEngine: IndexingReconciliationEngine | null = null;
  let archiveService: ArchiveService | null = null;
  let archiveStore: ArchiveStore | null = null;
  let metricsRunner: NotificationMetricsRunner | null = null;
  let metricsStore: NotificationMetricsStore | null = null;
  let deduplicationService: EventDeduplicationService | null = null;

  if (config.analytics?.enabled) {
    initNotificationAnalyticsAggregator(config.analytics);
  }

  try {
    logger.info('Initializing database');
    const db = await initializeDatabase(config.databasePath);

    repository = new ScheduledNotificationRepository(db);
    
    healthMonitor = new NotificationHealthMonitor(null, getWorkerManager(), {
      repository,
      getLastSuccessfulPoll: () => subscriber?.getLastSuccessfulPoll() ?? null,
    });

      getUptimeMs: () => Date.now() - PROCESS_START_TIME,
    });

    healthMonitor = new NotificationHealthMonitor(null, getWorkerManager(), {
      repository,
    });

    // Rebuild registry with configured event TTL
    if (config.cleanup) {
      eventRegistry.setTtlMs(config.cleanup.eventRetentionMs);
    }

    cleanupService = new CleanupService(db, eventRegistry, config.cleanup);
    cleanupService.start();

    reconciliationEngine = new IndexingReconciliationEngine({
      db,
      rpcUrl: config.stellarRpcUrl,
      contractAddresses: config.contractAddresses.map((c) => c.address),
      alertSink: createDefaultAlertSink(config.discord?.webhookUrl),
    });
    reconciliationEngine.start();

    if (config.analytics?.enabled) {
      metricsStore = new NotificationMetricsStore(db);
      metricsRunner = new NotificationMetricsRunner(config.analytics, metricsStore);
      await metricsRunner.start();
      logger.info('Notification metrics runner started successfully');
    }

    const archiveCfg = loadArchiveConfig();
    archiveStore = new ArchiveStore(db);
    archiveService = new ArchiveService(db, archiveCfg);
    await archiveService.initialize();
    if (archiveCfg.enabled) {
      archiveService.start();
      logger.info('ArchiveService started');
    }

    const templateRepository = new NotificationTemplateRepository(
      db,
      new TemplateAuditTrail(db),
      getTemplateCache(),
    );
    templateService = new NotificationTemplateService(templateRepository);

    if (config.scheduler?.enabled) {
      notificationAPI = new NotificationAPI(repository);

      const legacyTemplateRepo = new TemplateRepository(db);
      legacyTemplateService = new TemplateService(legacyTemplateRepo);

      logger.info('Template service initialized successfully');

      let discordService: DiscordNotificationService | null = null;
      if (config.discord) {
        discordService = new DiscordNotificationService(config.discord, undefined, config.retryQueue);
      }

      scheduler = new NotificationScheduler(repository, config.scheduler, discordService);
      await scheduler.start();

      logger.info('Notification scheduler started successfully');

      if (config.retryScheduler?.enabled) {
        retryScheduler = new RetryScheduler(repository, config.retryScheduler, discordService);
        await retryScheduler.start();
        logger.info('Retry scheduler started successfully');
      }
    }
  } catch (error) {
    logger.error('Failed to initialize database or scheduler', { error });
    throw error;
  }

  const eventsServer = startEventsServer({
    port: config.eventsApiPort,
    corsOrigin: config.eventsApiCorsOrigin,
    stellarRpcUrl: config.stellarRpcUrl,
    stellarNetworkPassphrase: config.stellarNetworkPassphrase,
    contractAddresses: config.contractAddresses,
    discordWebhookUrl: config.discord?.webhookUrl,
    notificationAPI,
    templateService,
    schedulerTemplateService: legacyTemplateService,
    webhookSecrets: config.webhookSecrets,
    apiKeys: config.apiKeys,
    rateLimit: config.rateLimit,
    archiveStore,
    archiveService,
    metricsStore,
    healthMonitor,
  });

  if (healthMonitor) {
    healthMonitor.start();
  }

  subscriber = new EventSubscriber(config, deduplicationService);
  const subscriber = new EventSubscriber(config, deduplicationService ?? undefined);
  await subscriber.start();

  let isShuttingDown = false;

  const shutdown = async (signal: string) => {
    // Idempotency: prevent duplicate shutdown if multiple signals arrive
    if (isShuttingDown) {
      logger.warn('Shutdown already in progress, ignoring signal', { signal });
      return;
    }

    isShuttingDown = true;
    logger.info('Graceful shutdown initiated', { signal });

    try {
      if (healthMonitor) {
        healthMonitor.stop();
      }

      if (cleanupService) {
        await cleanupService.stop();
      }

      if (reconciliationEngine) {
        reconciliationEngine.stop();
      }

      if (metricsRunner) {
        await metricsRunner.stop();
      }

      if (archiveService) {
        await archiveService.stop();
      }

      if (scheduler) {
        await scheduler.stop();
      }

      if (retryScheduler) {
        await retryScheduler.stop();
      }

    if (subscriber) {
      await subscriber.stop();
    }

    eventsServer.close();

      logger.info('Graceful shutdown completed successfully', { signal });
      process.exit(0);
    } catch (error) {
      logger.error('Error during graceful shutdown', { signal, error });
      process.exit(1);
    }
  };

  process.on('SIGINT', async () => {
    await shutdown('SIGINT');
  });

  process.on('SIGTERM', async () => {
    await shutdown('SIGTERM');
  });
}

main().catch((err) => {
  if (err instanceof SecretValidationError) {
    // Secret validation failures are reported field-by-field without echoing
    // actual secret values (#692).
    logger.error('Startup secret validation failed — service will not start', {
      error: err.message,
    });
  } else if (err instanceof ConfigError) {
    logger.error('Configuration error', { error: err.message });
  } else {
    logger.error('Error starting service', { error: err });
  }
  process.exit(1);
});