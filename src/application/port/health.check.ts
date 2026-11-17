export type HealthStatus = { status: 'up' | 'down'; details?: Record<string, unknown> }

/**
 * Verificação de uma dependência para o /health/ready.
 * critical: sem ela a API não consegue atender (ex.: MongoDB). As não críticas aparecem no relatório,
 * mas não tiram a instância do balanceamento (ex.: RabbitMQ fora do ar: os eventos esperam no outbox).
 */
export type HealthCheck = {
    name: string;
    critical: boolean;
    check(): Promise<HealthStatus>;
}
