import type { Job } from '../../domain/model/job.ts'

/** Executa o trabalho de um tipo de job. Deve ser idempotente: pode ser reexecutado após uma falha de infraestrutura. */
export type JobHandler = (job: Job) => Promise<unknown>
