import { JOB_LIST_LIMIT, type IJobRepository } from '../../../application/port/job.repository.ts'
import type { Job, JobStatus } from '../../../domain/model/job.ts'
import type { IJobModel } from '../../database/schema/index.ts'
import { JobMapper } from '../../mapper/job.mapper.ts'

export class InMemoryJobRepository implements IJobRepository {
    #docs = new Map<string, IJobModel>()
    #mapper = new JobMapper()

    public async save(job: Job): Promise<void> {
        this.#docs.set(job.id, structuredClone(this.#mapper.modelToModelEntity(job)))
    }

    public async findById(id: string): Promise<Job | null> {
        const doc = this.#docs.get(id)
        return this.#mapper.transform(doc && structuredClone(doc))
    }

    public async findByStatus(status: JobStatus): Promise<Job[]> {
        const docs = [...this.#docs.values()].filter(item => item.status === status)
        return this.#mapper.transform(docs.map(item => structuredClone(item)))
    }

    public async findAll(): Promise<Job[]> {
        return this.#newestFirst([...this.#docs.values()])
    }

    public async findByParticipant(userId: string): Promise<Job[]> {
        return this.#newestFirst([...this.#docs.values()].filter(item => item.managerId === userId || item.clientId === userId))
    }

    public async deleteFinishedBefore(date: Date): Promise<number> {
        let count = 0
        for (const [id, doc] of this.#docs) {
            if (doc.finishedAt && doc.finishedAt < date) {
                this.#docs.delete(id)
                count++
            }
        }
        return count
    }

    #newestFirst(docs: IJobModel[]): Job[] {
        const sorted = docs.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, JOB_LIST_LIMIT)
        return this.#mapper.transform(sorted.map(item => structuredClone(item)))
    }
}
