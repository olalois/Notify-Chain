/**
 * Configuration Schema Validation (#694)
 *
 * Provides deterministic, schema-based validation for application configuration:
 * - Configuration fields have explicit types and constraints.
 * - Required values are validated.
 * - Numeric ranges and enumerated values are validated.
 * - Validation errors identify the affected configuration field explicitly.
 */

export type FieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface SchemaFieldRule {
  type: FieldType;
  required?: boolean;
  min?: number;
  max?: number;
  enum?: readonly (string | number)[];
  pattern?: RegExp;
  custom?: (value: any, path: string) => string | null;
  description?: string;
}

export interface ConfigSchema {
  [field: string]: SchemaFieldRule | ConfigSchema;
}

export interface SchemaValidationError {
  field: string;
  expected: string;
  actual: any;
  message: string;
}

export class ConfigurationSchemaValidator {
  /**
   * Validate an arbitrary object against a schema definition.
   * Returns a list of all schema validation errors found.
   */
  public static validate(data: Record<string, any>, schema: ConfigSchema, prefix = ''): SchemaValidationError[] {
    const errors: SchemaValidationError[] = [];

    for (const [key, ruleOrNested] of Object.entries(schema)) {
      const fieldPath = prefix ? `${prefix}.${key}` : key;
      const value = data?.[key];

      // Check if it's a nested schema
      if (typeof ruleOrNested === 'object' && !('type' in ruleOrNested)) {
        if (value !== undefined && value !== null) {
          if (typeof value !== 'object' || Array.isArray(value)) {
            errors.push({
              field: fieldPath,
              expected: 'object',
              actual: typeof value,
              message: `Field "${fieldPath}" must be an object.`,
            });
          } else {
            const nestedErrors = this.validate(value, ruleOrNested as ConfigSchema, fieldPath);
            errors.push(...nestedErrors);
          }
        }
        continue;
      }

      const rule = ruleOrNested as SchemaFieldRule;

      // Check required
      if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
        if (rule.required) {
          errors.push({
            field: fieldPath,
            expected: `non-empty ${rule.type}`,
            actual: value === undefined ? 'undefined' : value === null ? 'null' : 'empty string',
            message: `Required field "${fieldPath}" is missing or empty.`,
          });
        }
        continue;
      }

      // Check type
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (actualType !== rule.type) {
        errors.push({
          field: fieldPath,
          expected: rule.type,
          actual: actualType,
          message: `Field "${fieldPath}" must be of type ${rule.type}, received ${actualType}.`,
        });
        continue;
      }

      // Check numeric bounds
      if (rule.type === 'number') {
        if (Number.isNaN(value) || !Number.isFinite(value)) {
          errors.push({
            field: fieldPath,
            expected: 'finite number',
            actual: String(value),
            message: `Field "${fieldPath}" must be a valid finite number.`,
          });
          continue;
        }

        if (rule.min !== undefined && value < rule.min) {
          errors.push({
            field: fieldPath,
            expected: `>= ${rule.min}`,
            actual: value,
            message: `Field "${fieldPath}" value ${value} is less than minimum ${rule.min}.`,
          });
        }

        if (rule.max !== undefined && value > rule.max) {
          errors.push({
            field: fieldPath,
            expected: `<= ${rule.max}`,
            actual: value,
            message: `Field "${fieldPath}" value ${value} exceeds maximum ${rule.max}.`,
          });
        }
      }

      // Check enum values
      if (rule.enum && !rule.enum.includes(value)) {
        errors.push({
          field: fieldPath,
          expected: `one of [${rule.enum.join(', ')}]`,
          actual: value,
          message: `Field "${fieldPath}" value "${value}" is not valid. Allowed values: ${rule.enum.join(', ')}.`,
        });
      }

      // Check regex pattern
      if (rule.pattern && typeof value === 'string' && !rule.pattern.test(value)) {
        errors.push({
          field: fieldPath,
          expected: `matching pattern ${rule.pattern}`,
          actual: value,
          message: `Field "${fieldPath}" value "${value}" does not match required pattern.`,
        });
      }

      // Custom rule check
      if (rule.custom) {
        const customErr = rule.custom(value, fieldPath);
        if (customErr) {
          errors.push({
            field: fieldPath,
            expected: 'custom validation constraint',
            actual: value,
            message: customErr,
          });
        }
      }
    }

    return errors;
  }
}

/**
 * Standard listener application configuration schema
 */
export const APP_CONFIG_SCHEMA: ConfigSchema = {
  stellarNetwork: {
    type: 'string',
    required: true,
    enum: ['testnet', 'public', 'futurenet', 'standalone', 'local'],
  },
  stellarRpcUrl: {
    type: 'string',
    required: true,
    pattern: /^https?:\/\//,
  },
  stellarNetworkPassphrase: {
    type: 'string',
    required: true,
  },
  pollIntervalMs: {
    type: 'number',
    required: true,
    min: 1000,
  },
  maxReconnectAttempts: {
    type: 'number',
    required: true,
    min: 1,
  },
  reconnectDelayMs: {
    type: 'number',
    required: true,
    min: 0,
  },
  eventsApiPort: {
    type: 'number',
    required: true,
    min: 1,
    max: 65535,
  },
  eventsApiCorsOrigin: {
    type: 'string',
    required: true,
  },
  contractAddresses: {
    type: 'array',
    required: true,
  },
  scheduler: {
    enabled: { type: 'boolean' },
    pollIntervalMs: { type: 'number', min: 1000 },
    lockTimeoutMs: { type: 'number', min: 1000 },
    batchSize: { type: 'number', min: 1 },
    timingBufferMs: { type: 'number', min: 0 },
  },
  retryQueue: {
    baseDelayMs: { type: 'number', min: 0 },
    multiplier: { type: 'number', min: 1 },
    maxDelayMs: { type: 'number', min: 1 },
    maxRetries: { type: 'number', min: 0 },
    processIntervalMs: { type: 'number', min: 1 },
  },
  retryScheduler: {
    enabled: { type: 'boolean' },
    pollIntervalMs: { type: 'number', min: 1000 },
    lockTimeoutMs: { type: 'number', min: 1000 },
    batchSize: { type: 'number', min: 1 },
    baseDelayMs: { type: 'number', min: 0 },
    multiplier: { type: 'number', min: 1 },
    maxDelayMs: { type: 'number', min: 1 },
  },
  rateLimit: {
    enabled: { type: 'boolean' },
    windowMs: { type: 'number', min: 1000 },
    maxRequests: { type: 'number', min: 1 },
  },
  analytics: {
    enabled: { type: 'boolean' },
    maxRecords: { type: 'number', min: 1 },
    maxBuckets: { type: 'number', min: 1 },
    bucketSizeMs: { type: 'number', min: 60000 },
    persistIntervalMs: { type: 'number', min: 1000 },
    snapshotRetentionDays: { type: 'number', min: 1 },
  },
  cleanup: {
    intervalMs: { type: 'number', min: 60000 },
    notificationRetentionMs: { type: 'number', min: 60000 },
    rateLimitEventRetentionMs: { type: 'number', min: 60000 },
    eventRetentionMs: { type: 'number', min: 60000 },
    executionLogRetentionMs: { type: 'number', min: 60000 },
  },
};
