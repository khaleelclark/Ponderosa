import { describe, expect, it } from "vitest";
import {
  guardedProviderExceptionStringProperty,
  restrictedProviderExceptionLogDetail,
} from "./provider-exception-properties.js";

describe("guardedProviderExceptionStringProperty", () => {
  it("is total across hostile Error-like values, functions, traps, and revoked proxies", () => {
    const marker = "PROVIDER_EXCEPTION_PROPERTY_MARKER_2d91";
    const errorLike = Object.create(Error.prototype) as object;
    Object.defineProperty(errorLike, "message", {
      get: () => { throw new Error(`${marker}:getter`); },
    });

    const callable = () => undefined;
    Object.defineProperty(callable, "message", {
      get: () => { throw new Error(`${marker}:function`); },
    });

    const trapped = new Proxy(Object.create(null) as object, {
      get: () => { throw new Error(`${marker}:get-trap`); },
      getOwnPropertyDescriptor: () => { throw new Error(`${marker}:descriptor-trap`); },
      getPrototypeOf: () => { throw new Error(`${marker}:prototype-trap`); },
    });
    const revocable = Proxy.revocable(Object.create(null) as object, {});
    revocable.revoke();

    for (const value of [
      errorLike,
      callable,
      trapped,
      revocable.proxy,
      null,
      undefined,
      marker,
      42,
      Symbol(marker),
    ]) {
      expect(() => guardedProviderExceptionStringProperty(value, "message")).not.toThrow();
      expect(guardedProviderExceptionStringProperty(value, "message")).toBeUndefined();
    }
  });

  it("returns only directly read string fields", () => {
    expect(guardedProviderExceptionStringProperty({ code: "rate_limit" }, "code"))
      .toBe("rate_limit");
    expect(restrictedProviderExceptionLogDetail(new Error("restricted provider detail")))
      .toBe("restricted provider detail");
    expect(guardedProviderExceptionStringProperty({ message: 409 }, "message"))
      .toBeUndefined();
  });
});
