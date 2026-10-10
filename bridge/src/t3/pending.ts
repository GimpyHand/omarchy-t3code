import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type { ApprovalDto, InputRequestDto } from "../protocol/types.ts";

type RequestProjection = Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">;

export function derivePendingApprovals(projection: RequestProjection): ApprovalDto[] {
  return derivePendingThreadRequests(projection).approvals.flatMap((request) => {
    if (request.responseCapability !== "live") return [];
    const kind = request.requestKind;
    if (kind !== "command" && kind !== "file-read" && kind !== "file-change") return [];
    return [
      {
        requestId: request.requestId,
        requestKind: kind,
        detail: request.detail ?? null,
        createdAt: request.createdAt,
      },
    ];
  });
}

export function derivePendingInputs(projection: RequestProjection): InputRequestDto[] {
  return derivePendingThreadRequests(projection).userInputs.flatMap((request) => {
    if (request.responseCapability !== "live") return [];
    return [
      {
        requestId: request.requestId,
        createdAt: request.createdAt,
        questions: request.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          multiSelect: question.multiSelect,
          options: question.options.map((option) => ({
            label: option.label,
            description: option.description,
          })),
        })),
      },
    ];
  });
}
