import type { Request, Response } from 'express'
import type { MfaService } from '../../application/service/mfa.service.ts'
import { getActor } from './auth.middleware.ts'

/** Segredo e códigos de recuperação aparecem uma única vez: nunca em cache. */
const noStore = (res: Response) => res.set('Cache-Control', 'no-store')

export function mfaController(service: MfaService) {
    return {
        status: async (_req: Request, res: Response) => {
            const status = await service.status(getActor(res))
            res.json({
                enabled: status.enabled,
                ...(status.enabledAt && { enabled_at: status.enabledAt }),
                recovery_codes_remaining: status.recoveryCodesRemaining,
                required: status.required,
            })
        },
        setup: async (_req: Request, res: Response) => {
            const setup = await service.setup(getActor(res))
            noStore(res).json({ secret: setup.secret, otpauth_url: setup.otpauthUrl, expires_in: setup.expiresIn })
        },
        enable: async (req: Request, res: Response) => {
            const { recoveryCodes } = await service.enable(getActor(res), req.body)
            noStore(res).json({ recovery_codes: recoveryCodes })
        },
        disable: async (req: Request, res: Response) => {
            await service.disable(getActor(res), req.body)
            res.status(204).end()
        },
        regenerateRecoveryCodes: async (req: Request, res: Response) => {
            const { recoveryCodes } = await service.regenerateRecoveryCodes(getActor(res), req.body)
            noStore(res).json({ recovery_codes: recoveryCodes })
        },
        reset: async (req: Request, res: Response) => {
            await service.reset(String(req.params.id))
            res.status(204).end()
        },
    }
}
