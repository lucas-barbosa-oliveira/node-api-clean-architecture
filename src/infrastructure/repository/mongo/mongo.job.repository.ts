import type { Model } from 'mongoose'
import type { IJobRepository } from '../../../application/port/job.repository.ts'
import type { ListQuery, Page } from '../../../application/query/list.query.ts'
import type { Job, JobStatus } from '../../../domain/model/job.ts'
import type { IJobModel } from '../../database/schema/index.ts'
import { JobMapper } from '../../mapper/job.mapper.ts'
import { BaseMongoRepository } from '../base/base.repository.ts'

export class MongoJobRepository extends BaseMongoRepository<Job, IJobModel> implements IJobRepository {
    constructor(model: Model<IJobModel>) {
        super(model, new JobMapper())
    }

    public save(job: Job): Promise<void> {
        return this.upsert(job)
    }

    public findByStatus(status: JobStatus): Promise<Job[]> {
        return this.find({ status })
    }

    public list(query: ListQuery): Promise<Page<Job>> {
        return this.findPage(query)
    }

    public deleteFinishedBefore(date: Date): Promise<number> {
        return this.deleteMany({ finishedAt: { $lt: date } })
    }
}
