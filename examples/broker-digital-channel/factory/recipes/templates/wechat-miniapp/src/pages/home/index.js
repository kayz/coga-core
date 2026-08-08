const { canPresentEntitledCapability } = require("../../domain/access.js");

Page({
  data: {
    title: "{{applicationTitle}}",
    accessState: "pending",
  },
  applyAuthoritativeContext(context) {
    this.setData({
      accessState: canPresentEntitledCapability(context) ? "allowed" : "denied",
    });
  },
});
