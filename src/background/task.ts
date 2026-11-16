/** Uma rotina de segundo plano: roda ao iniciar a aplicação, em um agendamento cron, ou ambos. */
export type BackgroundTask = {
  name: string;
  runOnStartup?: boolean;
  /** Expressão cron de 5 campos, ex.: '0 3 * * *' (todo dia às 03:00). */
  schedule?: string;
  run(signal: AbortSignal): Promise<void>;
}

export interface ITaskScheduler {
  start(): Promise<void>;
  stop(): Promise<void>;
}
