interface Notification {
  type: "email" | "sms" | "push" | "slack";
  recipient: string;
  message: string;
}

function sendNotification(notification: Notification): void {
  switch (notification.type) {
    case "email":
      console.log(`Sending email to ${notification.recipient}`);
      validateEmail(notification.recipient);
      formatHtmlBody(notification.message);
      callEmailApi(notification.recipient, notification.message);
      break;
    case "sms":
      console.log(`Sending SMS to ${notification.recipient}`);
      validatePhone(notification.recipient);
      truncateMessage(notification.message, 160);
      callSmsApi(notification.recipient, notification.message);
      break;
    case "push":
      console.log(`Sending push to ${notification.recipient}`);
      lookupDeviceToken(notification.recipient);
      callPushApi(notification.recipient, notification.message);
      break;
    case "slack":
      console.log(`Sending Slack to ${notification.recipient}`);
      resolveSlackChannel(notification.recipient);
      formatSlackBlocks(notification.message);
      callSlackApi(notification.recipient, notification.message);
      break;
  }
}
