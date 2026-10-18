/**
 * WP-2423: connection budget of the pilot's application role. Seven supervised services (API,
 * customer/merchant HTTPS and five workers) each open a pool of `pilotPoolSize` as the api role,
 * so the role must admit all of them at once plus headroom for operator commands. The ACL render
 * sets this limit; readiness reports not_ready below it rather than failing during a rush.
 */
export const pilotPoolSize = 5;
export const pilotSupervisedServices = 7;
export const pilotApiRoleConnectionLimit = pilotPoolSize * pilotSupervisedServices + 10;
