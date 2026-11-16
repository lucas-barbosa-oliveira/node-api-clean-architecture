import { setTimeout as sleep } from 'node:timers/promises'

/**
 * Exemplo de trabalho demorado executado em segundo plano.
 * Troque o corpo de generate() pelo trabalho real (consultas, geração de arquivo etc.).
 */
export class ReportService {
    #durationMs: number

    constructor(durationMs = 3000) {
        this.#durationMs = durationMs
    }

    public async generate(input: { month: string }): Promise<{ month: string; rows: number }> {
        await sleep(this.#durationMs)
        return { month: input.month, rows: 42 }
    }
}
