function canPresentEntitledCapability(context) {
  return Boolean(
    context &&
      context.authenticated === true &&
      context.entitlementDecision === "allow" &&
      context.entitlementFresh === true,
  );
}

module.exports = { canPresentEntitledCapability };
