import { Entity, type EntityProps } from './entity.ts'

export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export type JobProps = EntityProps & {
  type: string;
  payload: unknown;
  status?: JobStatus;
  result?: unknown;
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
}

export class Job extends Entity {
    public readonly type: string
    public readonly payload: unknown
    public status: JobStatus
    public result?: unknown
    public error?: string
    public startedAt?: Date
    public finishedAt?: Date

    constructor(props: JobProps) {
        super(props)
        this.type = props.type
        this.payload = props.payload
        this.status = props.status ?? 'pending'
        this.result = props.result
        this.error = props.error
        this.startedAt = props.startedAt
        this.finishedAt = props.finishedAt
    }

    public static create(type: string, payload: unknown): Job {
        return new Job({ type, payload })
    }

    public start(): void {
        this.status = 'running'
        this.startedAt = new Date()
        this.touch()
    }

    public succeed(result: unknown): void {
        this.status = 'succeeded'
        this.result = result
        this.finishedAt = new Date()
        this.touch()
    }

    public fail(error: string): void {
        this.status = 'failed'
        this.error = error
        this.finishedAt = new Date()
        this.touch()
    }
}
