import type { Job, JobStatus } from '../../domain/model/job.ts'

/** Limite das listagens enquanto não há paginação. */
export const JOB_LIST_LIMIT = 100

export interface IJobRepository {
  save(job: Job): Promise<void>;
  findById(id: string): Promise<Job | null>;
  findByStatus(status: JobStatus): Promise<Job[]>;
  /** Mais recentes primeiro (até JOB_LIST_LIMIT). */
  findAll(): Promise<Job[]>;
  /** Jobs em que o usuário é o gestor ou o cliente; mais recentes primeiro (até JOB_LIST_LIMIT). */
  findByParticipant(userId: string): Promise<Job[]>;
  deleteFinishedBefore(date: Date): Promise<number>;
}
