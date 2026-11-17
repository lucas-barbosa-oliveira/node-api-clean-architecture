import type { IJobRepository } from '../../../application/port/job.repository.ts'
import type { ListQuery, Page } from '../../../application/query/list.query.ts'
import type { Job, JobStatus } from '../../../domain/model/job.ts'
import type { IJobModel } from '../../database/schema/index.ts'
import { JobMapper } from '../../mapper/job.mapper.ts'
import { queryDocs } from './in.memory.query.ts'

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

    public async list(query: ListQuery): Promise<Page<Job>> {
        const { items, total } = queryDocs([...this.#docs.values()].map(doc => structuredClone(doc)), query)
        return { items: this.#mapper.transform(items), total }
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
}
