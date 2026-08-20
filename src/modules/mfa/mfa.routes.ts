import { Router } from 'express';
import { validate } from '../../common/middleware/index.js';
import { authenticate, requireUserActor } from '../auth/auth.middleware.js';
import { listDevices, revokeDevice } from './mfa.controller.js';
import { deviceIdParams } from './mfa.schema.js';

/**
 * A trusted device is a credential, so a user manages only their own — there is
 * deliberately no permission that lets one person revoke another's device.
 * Suspending the account revokes them all.
 */
export const trustedDeviceRouter: Router = Router();

trustedDeviceRouter.use(authenticate, requireUserActor);
trustedDeviceRouter.get('/', listDevices);
trustedDeviceRouter.delete('/:id', validate({ params: deviceIdParams }), revokeDevice);
