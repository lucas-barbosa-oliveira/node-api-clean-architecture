import type { JobHandler } from '../../application/port/job.handler.ts'
import type { ReportService } from '../../application/service/report.service.ts'

/** Liga cada tipo de job (o mesmo nome usado em domain/validator/job.validator.ts) ao service que faz o trabalho. */
export function buildJobHandlers(deps: { reportService: ReportService }): Record<string, JobHandler> {
    return {
        'report.generate': job => deps.reportService.generate(job.payload as { month: string }),
    }
}
