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
import { useState, useEffect } from "react";
import { useChat } from "@ai-sdk/react";
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

const InputDemo = () => {
  const [text, setText] = useState<string>("");
  const [model, setModel] = useState<string>(models[0].id);
  const [useWebSearch, setUseWebSearch] = useState<boolean>(false);
  const [availableTools, setAvailableTools] = useState<any[]>([]);

  const { messages, status, sendMessage, addToolOutput } = useChat({
    // maxSteps: 5,
//     api: '/api/chat',
//       body: {
//         tools,
//         context,
//         systemPrompt: `You are a helpful file analysis assistant. 
        
// When working with files:
// - Use listFiles to see what's available
// - Use readFile to access file content
// - Use analyzeData to provide insights
// - Use askForConfirmation before sensitive operations

// Be concise and helpful.`,
//       },
  });

  useEffect(() => {
    // Register global callbacks
    window.onToolsFetched = (tools) => {
      console.log("Tools fetched:", tools);
      // Map Rust ToolDefinition to what API expects
      // Rust: { name, description, parameters }
      // API Route expects: { name, description, inputSchema: parameters }
      const mappedTools = tools.map(t => ({
        name: t.name,
        description: t.description,
        inputSchema: t.parameters
      }));
      setAvailableTools(mappedTools);
    };

    window.onToolResult = (toolName, callId, result) => {
      console.log("Tool result received:", callId, result);
      addToolOutput({
        tool: toolName,
        // toolName: toolCall.toolName,
        toolCallId: callId,
        output: result,
      });
    };

    // Fetch tools from Rust
    if (window.ipc) {
      window.ipc.postMessage(JSON.stringify({ type: "fetch_tools" }));
    }

    return () => {
      // Cleanup if needed
      // window.onToolsFetched = undefined;
      // window.onToolResult = undefined;
    };
  }, [addToolOutput]);

  // Handle tool calls by monitoring messages
  // Ideally useChat would provide an onToolCall callback, but checking messages is also common pattern
  // actually useChat from @ai-sdk/react handles execution if we provide onToolCall? 
  // No, we want to manually handle it. 
  // The 'maxSteps' option in useChat allows automatic server-side roundtrips.
  // BUT we need to execute the tool on the CLIENT (Rust).
  // So we watch for the tool-call message, execute it, and then call addToolResult.
  
  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (!lastMessage || lastMessage.role !== 'assistant') return;
    
    // Check for tool invocations that don't have results yet
    if (lastMessage.toolInvocations) {
      for (const toolInvocation of lastMessage.toolInvocations) {
        if (toolInvocation.state === 'call') {
          console.log("Calling tool:", toolInvocation.toolName);
          if (window.ipc) {
            window.ipc.postMessage(JSON.stringify({
              type: "call_tool",
              name: toolInvocation.toolName,
              callId: toolInvocation.toolCallId,
              arguments: toolInvocation.args
            }));
          }
        }
      }
    }
  }, [messages]);

  const handleSubmit = (message: PromptInputMessage) => {
    const hasText = Boolean(message.text);
    const hasAttachments = Boolean(message.files?.length);

    if (!(hasText || hasAttachments)) {
      return;
    }

    sendMessage(
      {
        text: message.text || "Sent with attachments",
        files: message.files,
      },
      {
        body: {
          model: model,
          webSearch: useWebSearch,
          tools: availableTools, // Pass tools to API
        },
      }
    );
    setText("");
  };

  return (
    <div className="max-w-4xl mx-auto p-6 relative size-full rounded-lg border h-[95vh]">
      <div className="flex flex-col h-full">
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
                      case "tool-invocation":
                        const toolInvocation = part.toolInvocation;
                        return (
                          <div key={`${message.id}-${i}`} className="text-xs text-muted-foreground p-2 border rounded mt-2">
                            <div className="font-semibold">Tool Call: {toolInvocation.toolName}</div>
                            <div>Args: {JSON.stringify(toolInvocation.args)}</div>
                            {'result' in toolInvocation && (
                              <div className="mt-1 text-green-600">Result: {JSON.stringify(toolInvocation.result)}</div>
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

export default InputDemo;