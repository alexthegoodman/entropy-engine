"use client";

import { useEffect, useState } from "react";
import AgentChat from "./AgentChat";

const ChatContainer = () => {
    const [availableTools, setAvailableTools] = useState<any[]>([]);

    useEffect(() => {
        // Register global callbacks
        window.onToolsFetched = (tools) => {
          console.log("Tools fetched:", tools);
          // Map Rust ToolDefinition to what API expects
          // Rust: { name, description, parameters }
          // API Route expects: { name, description, inputSchema: parameters }
          const mappedTools = tools.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.parameters,
          }));
          setAvailableTools(mappedTools);
        };
    
        // Fetch tools from Rust
        setTimeout(() => {
          if (window.ipc) {
            window.ipc.postMessage(JSON.stringify({ type: "fetch_tools" }));
          }
        }, 2000);
    
        return () => {
          // Cleanup if needed
          // window.onToolsFetched = undefined;
          // window.onToolResult = undefined;
        };
      }, []);

      if (!availableTools.length) {
        return (
            <p>No tools available, please wait or refresh</p>
        )
      }

    return (
        <>
            <AgentChat availableTools={availableTools} />
        </>
    )
}

export default ChatContainer;