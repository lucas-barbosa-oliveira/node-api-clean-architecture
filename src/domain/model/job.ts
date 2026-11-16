import { Entity, type EntityProps } from './entity.ts'

export const JOB_STATUSES = ['pending', 'running', 'succeeded', 'failed'] as const
export type JobStatus = (typeof JOB_STATUSES)[number]

export type JobProps = EntityProps & {
  type: string;
  payload: unknown;
  /** Gestor que cadastrou o job. */
  managerId: string;
  /** Cliente ao qual o job está associado. */
  clientId: string;
  status?: JobStatus;
  result?: unknown;
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
}

export class Job extends Entity {
    public readonly type: string
    public readonly payload: unknown
    public readonly managerId: string
    public readonly clientId: string
    public status: JobStatus
    public result?: unknown
    public error?: string
    public startedAt?: Date
    public finishedAt?: Date

    constructor(props: JobProps) {
        super(props)
        this.type = props.type
        this.payload = props.payload
        this.managerId = props.managerId
        this.clientId = props.clientId
        this.status = props.status ?? 'pending'
        this.result = props.result
        this.error = props.error
        this.startedAt = props.startedAt
        this.finishedAt = props.finishedAt
    }

    public static create(data: { type: string; payload: unknown; managerId: string; clientId: string }): Job {
        return new Job(data)
    }

    /** O usuário participa do job (é o gestor que o criou ou o cliente associado). */
    public involves(userId: string): boolean {
        return this.managerId === userId || this.clientId === userId
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
