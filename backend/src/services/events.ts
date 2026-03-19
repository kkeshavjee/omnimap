// OmniMap — Event Bus Stub
// In production: publishes to AWS EventBridge.
// In dev (no AWS): logs the event and returns immediately.
// Services call emit() after completing their DAG node.
// The event payload matches the EventBridge detail schema.

export interface OmniMapEvent {
  source:     'omnimap';
  detailType: string;           // e.g. 'PROJECT_INIT_COMPLETE'
  detail: {
    projectId:  string;
    node:       string;         // e.g. 'NODE_0_PROJECT_INIT'
    nextNode:   string;
    [key: string]: unknown;
  };
}

export async function emit(event: OmniMapEvent): Promise<void> {
  if (process.env.AWS_EVENTBRIDGE_BUS_NAME) {
    // Production: publish to EventBridge (wired in Phase 2)
    // const eb = new EventBridgeClient({});
    // await eb.send(new PutEventsCommand({ Entries: [{ ... }] }));
    throw new Error('EventBridge not yet wired — Phase 2');
  }

  // Dev: log only
  console.log('[EventBus]', JSON.stringify(event, null, 2));
}
