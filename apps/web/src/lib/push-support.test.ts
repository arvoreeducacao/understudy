import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAppleTouchDevice, pushSupport } from "./push-support";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const IPAD_DESKTOP_MODE = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";

describe("push support", () => {
  it("is supported wherever the push API exists", () => {
    assert.equal(pushSupport({ userAgent: IPHONE, maxTouchPoints: 5, standalone: true, hasPushApi: true }), "supported");
    assert.equal(pushSupport({ userAgent: ANDROID, maxTouchPoints: 5, standalone: false, hasPushApi: true }), "supported");
  });

  it("asks iPhone and iPad users to install the app first when it runs in a tab", () => {
    assert.equal(pushSupport({ userAgent: IPHONE, maxTouchPoints: 5, standalone: false, hasPushApi: false }), "install-first");
    assert.equal(pushSupport({ userAgent: IPAD_DESKTOP_MODE, maxTouchPoints: 5, standalone: false, hasPushApi: false }), "install-first");
  });

  it("says unsupported when installing would not help", () => {
    assert.equal(pushSupport({ userAgent: IPHONE, maxTouchPoints: 5, standalone: true, hasPushApi: false }), "unsupported");
    assert.equal(pushSupport({ userAgent: ANDROID, maxTouchPoints: 5, standalone: false, hasPushApi: false }), "unsupported");
  });

  it("does not mistake a Mac for an iPad", () => {
    assert.equal(isAppleTouchDevice(IPAD_DESKTOP_MODE, 0), false);
  });
});
