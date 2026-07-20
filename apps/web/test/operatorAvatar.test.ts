import { describe, expect, it } from "vitest";
import { operatorAvatarUrl } from "../src/components/OperatorAvatar";

describe("Operator avatar presentation", () => {
  it("uses a same-origin managed URL only for durable uploaded avatar identities", () => {
    const avatarId = `uploaded:png:${"a".repeat(64)}`;
    expect(operatorAvatarUrl(avatarId)).toBe(`/api/workspace/profile-images/${encodeURIComponent(avatarId)}`);
    expect(operatorAvatarUrl("default-user")).toBeUndefined();
  });
});
