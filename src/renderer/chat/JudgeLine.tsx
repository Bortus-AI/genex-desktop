import type { JSX } from "react";
import type { ChatJudgeResultPayload } from "../../shared/chat-judge.ts";
import { CHECK_MARKS, judgeLineLabel } from "../outcome-checks.ts";
import { Icon } from "../ui/icons.tsx";
import { CHAT_JUDGE_WORDS } from "../words.ts";
import { ChatDisclosure } from "./ChatDisclosure.tsx";

/**
 * A blind judge's play for the chat's own session (`chat_judge_result`): one line in the words of a
 * build's checks list, its state's mark leading it, and inside the question with the judge's note,
 * or why nothing was played.
 */
export function JudgeLine({ judge }: { judge: ChatJudgeResultPayload }): JSX.Element {
  const mark = CHECK_MARKS[judge.status];
  const said = judge.refusal ?? judge.note;
  return (
    <ChatDisclosure
      data-judge-line={judge.status}
      lead={<Icon name={mark.icon} size={14} strokeWidth={2} className={`shrink-0 ${mark.tone}`} />}
      label={judgeLineLabel(judge)}
      wraps
    >
      <div className="flex flex-col gap-1 text-chat-sub [overflow-wrap:anywhere]">
        <p className="text-ink-2">
          {CHAT_JUDGE_WORDS.asked} {judge.ask}
        </p>
        {said && <p className="text-ink-3">{said}</p>}
      </div>
    </ChatDisclosure>
  );
}
