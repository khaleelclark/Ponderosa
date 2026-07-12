export function directMessageSender(role: "user" | "assistant", agentName: string): string {
  return role === "user" ? "You" : agentName.trim() || "Agent";
}
