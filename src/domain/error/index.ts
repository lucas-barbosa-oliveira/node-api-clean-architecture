export class AppError extends Error {
    public readonly code: string

    constructor(code: string, message: string) {
        super(message)
        this.name = new.target.name
        this.code = code
    }
}

export class ValidationError extends AppError {
    public readonly issues: unknown[]

    constructor(message: string, issues: unknown[] = []) {
        super('VALIDATION', message)
        this.issues = issues
    }
}

export class ConflictError extends AppError {
    constructor(message: string) {
        super('CONFLICT', message)
    }
}

export class NotFoundError extends AppError {
    constructor(message: string) {
        super('NOT_FOUND', message)
    }
}
