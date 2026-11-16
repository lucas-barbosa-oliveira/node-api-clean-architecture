export interface IJobQueue {
  enqueue(jobId: string): Promise<void>;
  /** Para de iniciar novos jobs e espera os em andamento terminarem. */
  close(): Promise<void>;
}
