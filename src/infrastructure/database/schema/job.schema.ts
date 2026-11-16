import mongoose from 'mongoose'
import { JOB_STATUSES, type JobStatus } from '../../../domain/model/job.ts'

export interface IJobModel {
  _id: string;
  type: string;
  status: JobStatus;
  payload: unknown;
  result?: unknown;
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  finishedAt?: Date;
}

export const jobSchema = new mongoose.Schema<IJobModel>(
    {
        _id: { type: String, required: true },
        type: { type: String, required: true },
        status: { type: String, required: true, enum: JOB_STATUSES },
        payload: { type: mongoose.Schema.Types.Mixed },
        result: { type: mongoose.Schema.Types.Mixed },
        error: { type: String },
        createdAt: { type: Date, required: true },
        updatedAt: { type: Date, required: true },
        startedAt: { type: Date },
        finishedAt: { type: Date },
    },
    // minimize: false evita que o Mongoose descarte payload/result iguais a {}
    { collection: 'jobs', versionKey: false, minimize: false },
)

jobSchema.index({ status: 1 })
