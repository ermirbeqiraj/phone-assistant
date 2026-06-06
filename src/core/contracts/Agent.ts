export type AgentResponse = {
  text: string;
  hangup: boolean;
};

export type Turn = { role: 'user' | 'assistant'; content: string };

export interface Agent {
  respond(history: Turn[], signal?: AbortSignal): Promise<AgentResponse>;
}
