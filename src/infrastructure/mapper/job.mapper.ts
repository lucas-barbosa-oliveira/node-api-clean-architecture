import { Job } from '../../domain/model/job.ts'
import type { IJobModel } from '../database/schema/index.ts'
import { BaseMapper } from './entity.mapper.ts'

const toDate = (value: unknown): Date | undefined =>
    value == null ? undefined : new Date(value as string | number | Date)

export class JobMapper extends BaseMapper<Job, IJobModel> {
    public modelToModelEntity(job: Job): IJobModel {
        return {
            _id: job.id,
            type: job.type,
            status: job.status,
            payload: job.payload,
            result: job.result,
            error: job.error,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
        }
    }

    public jsonToModel(json: IJobModel): Job {
        return new Job({
            id: json._id,
            type: json.type,
            status: json.status,
            payload: json.payload,
            result: json.result,
            error: json.error,
            createdAt: new Date(json.createdAt),
            updatedAt: new Date(json.updatedAt),
            startedAt: toDate(json.startedAt),
            finishedAt: toDate(json.finishedAt),
        })
    }
}
