import type { OperatorProfileDto } from "@ponderosa/core";
import { MessageSenderLabel } from "../MessageSenderLabel";
import { MessageTimestamp } from "../MessageTimestamp";
import { OperatorAvatar } from "../OperatorAvatar";

export function ChatOperatorLabel({ profile, createdAt }: { profile?: OperatorProfileDto; createdAt?: string }): JSX.Element {
  const name = profile?.displayName ?? "User";
  return (
    <div className="MuiStack-root chat-operator-label">
      {createdAt ? <div className="MuiBox-root chat-message-secondary"><MessageTimestamp value={createdAt} align="end" desktopOnly /></div> : null}
      <div className="MuiBox-root chat-operator-sender"><MessageSenderLabel name={name} /></div>
      <div className="MuiBox-root chat-operator-avatar"><OperatorAvatar profile={profile} compactOnMobile /></div>
    </div>
  );
}
