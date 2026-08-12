import type { WorkOrder } from "./types.js";

export const GITHUB_FACTORY_TOKEN_ENVIRONMENT =
  "COGA_FACTORY_GITHUB_TOKEN" as const;

export function expectedDeliveryAuthor(workOrder: WorkOrder): string {
  return `${workOrder.spec.delivery.identity.appSlug}[bot]`;
}

export function assertSeparatedDeliveryIdentity(workOrder: WorkOrder): void {
  const identity = workOrder.spec.delivery.identity;
  if (identity.tokenEnvironment !== GITHUB_FACTORY_TOKEN_ENVIRONMENT) {
    throw new Error(
      `GitHub App delivery must use the fixed '${GITHUB_FACTORY_TOKEN_ENVIRONMENT}' credential boundary.`,
    );
  }
  const machineIdentities = new Set([
    identity.appSlug.toLowerCase(),
    expectedDeliveryAuthor(workOrder).toLowerCase(),
  ]);
  const humanIdentities = [
    ...workOrder.spec.governance.promotion.authorizedApprovers,
    ...workOrder.spec.governance.approvals.map((entry) => entry.approver),
  ];
  const overlapping = humanIdentities.find((entry) =>
    machineIdentities.has(entry.toLowerCase()),
  );
  if (overlapping) {
    throw new Error(
      `Delivery identity '${identity.appSlug}' cannot be used as a human approver ('${overlapping}').`,
    );
  }
}
