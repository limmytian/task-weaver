export function shouldSendChatMessage(event: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}, compositionActive: boolean) {
  return event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229 && !compositionActive;
}
