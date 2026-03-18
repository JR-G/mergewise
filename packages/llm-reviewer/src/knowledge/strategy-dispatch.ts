import type { KnowledgeDocument } from "../pipeline-types";

/**
 * Knowledge document for detecting strategy pattern opportunities and type dispatch chains.
 *
 * @remarks
 * Draws from the Strategy pattern (Gang of Four), the Open/Closed Principle
 * (Robert C. Martin), and Martin Fowler's "Replace Conditional with Polymorphism"
 * refactoring.
 */
export const STRATEGY_DISPATCH_KNOWLEDGE: KnowledgeDocument = {
  id: "strategy-dispatch",
  title: "Strategy Pattern and Type Dispatch",
  category: "clean",
  triggerSignals: ["high_nesting", "large_function"],
  triggerClassifications: [
    "strategy-pattern",
    "switch-chain",
    "god-function-growth",
  ],
  fileExtensions: [],
  content: `A large switch or if-else chain that dispatches on a type discriminator centralises all variant-specific logic in a single site. Every new variant forces edits to that function, violating the Open/Closed Principle — the function is never closed for modification.

Detection criteria:
- A switch statement or if-else chain with four or more branches dispatching on a string literal, enum, or discriminated union tag
- instanceof chains that choose behaviour based on the runtime class of an object
- Functions where each branch contains non-trivial logic (more than a single return or assignment) — not just value lookups
- Nested dispatch: a switch inside a switch, or an if-else chain whose branches contain further conditionals on the same discriminator

The concrete cost:
- Adding a new variant (e.g. a new notification channel) requires modifying the dispatch function, which touches every existing variant's code in the same scope
- The dispatch function accumulates all variant-specific imports, helpers, and error handling — becoming a god function over time
- Testing one variant requires setting up the entire dispatch context, because the function cannot be invoked for a single branch in isolation

Solutions:
- Strategy record: a Record<DiscriminatorType, StrategyFunction> that maps each variant to its handler, with dispatch reduced to a single lookup
- Polymorphic dispatch: define an interface with the shared method signature and let each variant implement it — dispatch becomes a method call
- Handler registry: a Map or array that variants register themselves into, decoupling the dispatch site from variant knowledge entirely

When NOT to flag:
- Exhaustive switches on small discriminated unions (two or three cases) where the total logic is under 20 lines — extraction adds indirection without benefit
- Switches that return a value directly with no side effects (pure lookup semantics) — these are effectively lookup tables already
- Reducer patterns in state management (useReducer, Redux) where the switch is the idiomatic dispatch mechanism`,
  examples: [
    {
      label: "Notification switch refactored to strategy record",
      scenario:
        "A notification service dispatches on channel type (email, SMS, push, Slack) to send messages. Each branch constructs a payload, calls a different client, and logs the result.",
      bad: `async function sendNotification(channel: NotificationChannel, message: Message): Promise<void> {
  switch (channel) {
    case "email": {
      const payload = { to: message.recipient, subject: message.title, html: message.body };
      await emailClient.send(payload);
      logger.info("Email sent", { recipient: message.recipient });
      break;
    }
    case "sms": {
      const payload = { phoneNumber: message.recipient, text: message.body.slice(0, 160) };
      await smsClient.send(payload);
      logger.info("SMS sent", { recipient: message.recipient });
      break;
    }
    case "push": {
      const payload = { token: message.deviceToken, title: message.title, body: message.body };
      await pushClient.send(payload);
      logger.info("Push sent", { token: message.deviceToken });
      break;
    }
    case "slack": {
      const payload = { channel: message.slackChannel, text: message.body };
      await slackClient.postMessage(payload);
      logger.info("Slack sent", { channel: message.slackChannel });
      break;
    }
    default:
      throw new Error(\`Unsupported channel: \${String(channel)}\`);
  }
}`,
      good: `interface NotificationStrategy {
  send(message: Message): Promise<void>;
}

const strategies: Record<NotificationChannel, NotificationStrategy> = {
  email: {
    async send(message) {
      const payload = { to: message.recipient, subject: message.title, html: message.body };
      await emailClient.send(payload);
      logger.info("Email sent", { recipient: message.recipient });
    },
  },
  sms: {
    async send(message) {
      const payload = { phoneNumber: message.recipient, text: message.body.slice(0, 160) };
      await smsClient.send(payload);
      logger.info("SMS sent", { recipient: message.recipient });
    },
  },
  push: {
    async send(message) {
      const payload = { token: message.deviceToken, title: message.title, body: message.body };
      await pushClient.send(payload);
      logger.info("Push sent", { token: message.deviceToken });
    },
  },
  slack: {
    async send(message) {
      const payload = { channel: message.slackChannel, text: message.body };
      await slackClient.postMessage(payload);
      logger.info("Slack sent", { channel: message.slackChannel });
    },
  },
};

async function sendNotification(channel: NotificationChannel, message: Message): Promise<void> {
  const strategy = strategies[channel];
  if (!strategy) {
    throw new Error(\`Unsupported channel: \${String(channel)}\`);
  }
  await strategy.send(message);
}`,
      explanation:
        "Adding a new channel (e.g. webhook) requires adding an entry to the strategies record without touching the dispatch function. Each strategy can be tested independently by importing it from the record.",
    },
  ],
};
