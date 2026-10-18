import { UserMessage } from "../chat/UserMessage.tsx";
import type { ReferenceFrame } from "../../shared/protocol.ts";
import { CHAT_WORDS } from "../words.ts";

/** The line under a follow-up until the work reads it: Sending…, always 24px tall, so nothing moves. */
function SendingLine() {
  return (
    <div className="flex min-h-6 items-center text-xs text-ink-3">
      <span role="status">{CHAT_WORDS.sendingMessage}</span>
    </div>
  );
}

/** Sent during work and not saved yet: it waits where it will wait once saved. */
export function SendingMessage({ text, frames }: { text: string; frames?: ReferenceFrame[] }) {
  return (
    <div data-sending-message className="flex min-w-0 flex-col items-end gap-0.5">
      <UserMessage text={text} pending frames={frames} />
      <SendingLine />
    </div>
  );
}

/**
 * A saved follow-up waiting below the current work: that work reads it at its next step, so it
 * reads Sending… until then and there is nothing to withdraw. How it arrives and leaves is the
 * conversation's (`Presence`).
 */
export function QueuedMessage({
  threadId,
  messageId,
  text,
  images,
}: {
  threadId: string;
  messageId: string;
  text: string;
  /** Pictures sent with it: how many, when the log knows. */
  images?: { count?: number };
}) {
  return (
    <div data-queued-message={messageId} className="flex min-w-0 flex-col items-end gap-0.5">
      <UserMessage
        text={text}
        pending
        {...(images ? { threadId, imagesOf: messageId, imageCount: images.count } : {})}
      />
      <SendingLine />
    </div>
  );
}
