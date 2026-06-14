"use client";
import { createContext, useContext, useState } from "react";

const AnalyzeContext = createContext<{
  queuedLeads: Set<string>;
  markQueued: (leadIds: string[]) => void;
}>({ queuedLeads: new Set(), markQueued: () => {} });

export function AnalyzeProvider({ children }: { children: React.ReactNode }) {
  const [queuedLeads, setQueuedLeads] = useState<Set<string>>(new Set());
  const markQueued = (leadIds: string[]) =>
    setQueuedLeads((prev) => new Set([...prev, ...leadIds]));
  return (
    <AnalyzeContext.Provider value={{ queuedLeads, markQueued }}>
      {children}
    </AnalyzeContext.Provider>
  );
}

export function useAnalyzeQueue() {
  return useContext(AnalyzeContext);
}
