import type { Job, JobStatus } from '../../domain/model/job.ts'
import type { ListQuery, Page } from '../query/list.query.ts'

export interface IJobRepository {
  save(job: Job): Promise<void>;
  findById(id: string): Promise<Job | null>;
  findByStatus(status: JobStatus): Promise<Job[]>;
  /** Filtro, ordenação e paginação já validados (ver JOB_QUERY_SCHEMA). */
  list(query: ListQuery): Promise<Page<Job>>;
  deleteFinishedBefore(date: Date): Promise<number>;
}
