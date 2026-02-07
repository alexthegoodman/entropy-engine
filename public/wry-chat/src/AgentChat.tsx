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

const AgentChat = ({ availableTools = [] }: { availableTools: any[] }) => {
  const [text, setText] = useState<string>("");
  const [model, setModel] = useState<string>(models[0].id);
  const [useWebSearch, setUseWebSearch] = useState<boolean>(false);
  // const [availableTools, setAvailableTools] = useState<any[]>([]);
  const [initialMessages, setInitialMessages] = useState<any[]>([]); // Use any[] or UIMessage[] based on types

  const transport = useMemo(
    () =>
      new DefaultChatTransport({
        api: "http://localhost:3000/api/sessions/123/messages",
        body: {
          model,
          webSearch: useWebSearch,
          tools: availableTools,
          // systemPrompt: `You are a helpful file analysis assistant. 
          
          // When working with files:
          // - Use listFiles to see what's available
          // - Use readFile to access file content
          // - Use analyzeData to provide insights
          // - Use askForConfirmation before sensitive operations
          
          // Be concise and helpful.`,
        },
      }),
    [model, useWebSearch, availableTools],
  );

  const { messages, status, sendMessage, addToolOutput } = useChat({
    transport,
    // initialMessages,
    onToolCall: ({ toolCall }) => {
      console.log("Calling tool:", toolCall.toolName);
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