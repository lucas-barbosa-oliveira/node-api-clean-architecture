import type { Job, JobStatus } from '../../domain/model/job.ts'

export interface IJobRepository {
  save(job: Job): Promise<void>;
  findById(id: string): Promise<Job | null>;
  findByStatus(status: JobStatus): Promise<Job[]>;
  deleteFinishedBefore(date: Date): Promise<number>;
}
