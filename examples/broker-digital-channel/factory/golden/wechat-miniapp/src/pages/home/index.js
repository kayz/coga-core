const { canPresentEntitledCapability } = require("../../domain/access.js");

Page({
  data: {
    title: "Aster Learning Mini Program",
    accessState: "pending",
  },
  applyAuthoritativeContext(context) {
    this.setData({
      accessState: canPresentEntitledCapability(context) ? "allowed" : "denied",
    });
  },
});
