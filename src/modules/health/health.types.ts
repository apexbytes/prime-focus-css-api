export type HealthState = 'ok' | 'degraded' | 'unavailable';

export type DependencyState = 'ok' | 'unavailable' | 'not_configured';

export interface DependencyStatus {
  name: string;
  /** `not_configured` marks a dependency that a later phase introduces. */
  state: DependencyState;
  latencyMs?: number;
  error?: string;
}

export interface LivenessReport {
  status: 'ok';
  service: string;
  version: string;
  commit: string;
  environment: string;
  uptimeSeconds: number;
  timestamp: string;
}

export interface ReadinessReport {
  status: HealthState;
  shuttingDown: boolean;
  dependencies: DependencyStatus[];
  timestamp: string;
}
