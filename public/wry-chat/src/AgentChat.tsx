"use client";

import {
  Attachment,
  AttachmentPreview,
  AttachmentRemove,
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputHeader,
  type PromptInputMessage,
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputFooter,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { GlobeIcon } from "lucide-react";
import { useState, useEffect, useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";

declare global {
  interface Window {
    ipc: {
      postMessage: (message: string) => void;
    };
    onToolsFetched: (tools: any[]) => void;
    onToolResult: (toolName: string, callId: string, result: any) => void;
  }
}

const PromptInputAttachmentsDisplay = () => {
  const attachments = usePromptInputAttachments();

  if (attachments.files.length === 0) {
    return null;
  }

  return (
    <Attachments variant="inline">
      {attachments.files.map((attachment) => (
        <Attachment
          data={attachment}
          key={attachment.id}
          onRemove={() => attachments.remove(attachment.id)}
        >
          <AttachmentPreview />
          <AttachmentRemove />
        </Attachment>
      ))}
    </Attachments>
  );
};

const models = [
  { id: "gpt-4o", name: "GPT-4o" },
  { id: "claude-opus-4-20250514", name: "Claude 4 Opus" },
];

interface PlanStep {
  id: string;
  description: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

const PLAN_TOOL = {
  name: "manage_plan",
  description:
    "Create or update a multi-step plan. Use this to outline the steps you will take to complete the request. Call this tool whenever you start a new plan or complete a step.",
  inputSchema: {
    type: "object",
    properties: {
      steps: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            description: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed", "failed"],
            },
          },
          required: ["id", "description", "status"],
        },
      },
    },
    required: ["steps"],
  },
};

const AgentChat = ({ availableTools = [] }: { availableTools: any[] }) => {
  const [text, setText] = useState<string>("");
  const [model, setModel] = useState<string>(models[0].id);
  const [useWebSearch, setUseWebSearch] = useState<boolean>(false);
  // const [availableTools, setAvailableTools] = useState<any[]>([]);
  const [initialMessages, setInitialMessages] = useState<any[]>([]); // Use any[] or UIMessage[] based on types
  const [plan, setPlan] = useState<PlanStep[]>([]);

  const allTools = useMemo(
    () => [...availableTools, PLAN_TOOL],
    [availableTools],
  );

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "http://localhost:3000/api/sessions/123/messages",
        body: {
          model,
          webSearch: useWebSearch,
          tools: allTools,
          systemPrompt: `You are a helpful AI assistant for the Entropy Engine.
          
          For complex requests:
          1. create a plan using the 'manage_plan' tool.
          2. Execute one step at a time.
          3. After each step, update the plan status using 'manage_plan' and decide if you need to revise the plan based on the results.
          
          Always keep the user informed.`,
        },
      }),
    [model, useWebSearch, allTools],
  );

  const { messages, status, sendMessage, addToolOutput } = useChat({
    transport,
    // initialMessages,
    onToolCall: ({ toolCall }) => {
      console.log("Calling tool:", toolCall.toolName);

      if (toolCall.toolName === "manage_plan") {
        const args = toolCall.input as any;
        if (args.steps) {
            setPlan(args.steps);
        }
        
        addToolOutput({
            toolCallId: toolCall.toolCallId,
            tool: toolCall.toolName,
            output: { result: "Plan updated successfully." },
        });
        return;
      }

      if (window.ipc) {
        window.ipc.postMessage(
          JSON.stringify({
            type: "call_tool",
            name: toolCall.toolName,
            callId: toolCall.toolCallId,
            arguments: JSON.stringify(toolCall.input),
          }),
        );
      }
    },
  });

  useEffect(() => {
    setInitialMessages(messages);
  }, [messages]);

  useEffect(() => {
    window.onToolResult = (toolName, callId, result) => {
      console.log("Tool result received:", callId, result);
      addToolOutput({
        tool: toolName,
        toolCallId: callId,
        output: result,
      });
    };

    return () => {
      // Cleanup if needed
      // window.onToolsFetched = undefined;
      // window.onToolResult = undefined;
    };
  }, [addToolOutput]);

  const handleSubmit = async (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);

    if (!(hasText || hasAttachments)) {
      return;
    }

    const textContent = message.text || "Sent with attachments";
    const files = message.files ?? [];

    const fileParts = await Promise.all(
      files.map(
        (file) =>
          new Promise<{ type: "file"; mediaType: string; url: string }>(
            (resolve, reject) => {
              const reader = new FileReader();
              reader.onload = () => {
                resolve({
                  type: "file",
                  mediaType: file.type,
                  url: reader.result as string,
                });
              };
              reader.onerror = reject;
              reader.readAsDataURL(file as any);
            },
          ),
      ),
    );

    sendMessage({
      role: "user",
      parts: [{ type: "text", text: textContent }, ...fileParts],
    });
    setText("");
  };

  return (
    <div className="max-w-4xl mx-auto p-6 relative size-full rounded-lg border h-[95vh]">
      <div className="flex flex-col h-full">
        {plan.length > 0 && (
          <div className="bg-muted/50 p-4 rounded-lg mb-4 text-sm max-h-[200px] overflow-y-auto">
            <h3 className="font-semibold mb-2">Current Plan</h3>
            <div className="space-y-2">
              {plan.map((step) => (
                <div key={step.id} className="flex items-center gap-2">
                  <div
                    className={`size-2 rounded-full ${
                      step.status === "completed"
                        ? "bg-green-500"
                        : step.status === "in_progress"
                        ? "bg-blue-500 animate-pulse"
                        : step.status === "failed"
                        ? "bg-red-500"
                        : "bg-gray-300"
                    }`}
                  />
                  <span
                    className={
                      step.status === "completed"
                        ? "text-muted-foreground line-through"
                        : ""
                    }
                  >
                    {step.description}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
        {/* <p className="text-xs">{JSON.stringify(availableTools)}</p> */}
        <Conversation>
          <ConversationContent>
            {messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, i) => {
                    switch (part.type) {
                      case "text":
                        return (
                          <MessageResponse key={`${message.id}-${i}`}>
                            {part.text}
                          </MessageResponse>
                        );
                      case "tool-call":
                        const toolCall = part;
                        return (
                          <div
                            key={`${message.id}-${i}`}
                            className="text-xs text-muted-foreground p-2 border rounded mt-2"
                          >
                            <div className="font-semibold">
                              Tool Call: {toolCall.title}
                            </div>
                            <div>Args: {JSON.stringify(toolCall.input)}</div>
                            {"output" in toolCall && (
                              <div className="mt-1 text-green-600">
                                Result: {JSON.stringify(toolCall.output)}
                              </div>
                            )}
                          </div>
                        );
                      default:
                        return null;
                    }
                  })}
                </MessageContent>
              </Message>
            ))}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>

        <PromptInput
          onSubmit={handleSubmit}
          className="mt-4"
          globalDrop
          multiple
        >
          <PromptInputHeader>
            <PromptInputAttachmentsDisplay />
          </PromptInputHeader>
          <PromptInputBody>
            <PromptInputTextarea
              onChange={(e) => setText(e.target.value)}
              value={text}
              placeholder="Ask Chat to handle the grunt work"
            />
          </PromptInputBody>
          <PromptInputFooter>
            <PromptInputTools>
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger />
                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments />
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
            </PromptInputTools>
            <PromptInputSubmit disabled={!text && !status} status={status} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
};

export default AgentChat;