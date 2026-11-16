import type { Model } from 'mongoose'
import { JOB_LIST_LIMIT, type IJobRepository } from '../../../application/port/job.repository.ts'
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

    public findAll(): Promise<Job[]> {
        return this.find({}, { sort: { createdAt: -1 }, limit: JOB_LIST_LIMIT })
    }

    public findByParticipant(userId: string): Promise<Job[]> {
        const filter = { $or: [{ managerId: userId }, { clientId: userId }] }
        return this.find(filter, { sort: { createdAt: -1 }, limit: JOB_LIST_LIMIT })
    }

    public deleteFinishedBefore(date: Date): Promise<number> {
        return this.deleteMany({ finishedAt: { $lt: date } })
    }
}
