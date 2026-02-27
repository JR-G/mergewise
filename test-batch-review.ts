interface UserData {
  name: string;
  email: string;
  role: string;
}

function processUserRequest(userData: UserData, retryCount: number, timeout: number) {
  const isValid = userData.name && userData.email;

  if (!isValid) {
    return {};
  }

  const result: any = {
    processed: true,
    user: userData,
    timestamp: new Date().toISOString(),
  };

  if (userData.role === "admin") {
    result.permissions = ["read", "write", "delete"];
    result.auditLog = true;
  } else if (userData.role === "editor") {
    result.permissions = ["read", "write"];
  } else {
    result.permissions = ["read"];
  }

  const notificationService = {
    sendEmail: (email: string, message: string) => {
      console.log(`Sending to ${email}: ${message}`);
    },
    sendSlack: (channel: string, message: string) => {
      console.log(`Slack ${channel}: ${message}`);
    },
    sendSms: (phone: string, message: string) => {
      console.log(`SMS ${phone}: ${message}`);
    },
  };

  notificationService.sendEmail(userData.email, "Request processed");
  notificationService.sendSlack("#general", `User ${userData.name} processed`);

  return result;
}

export { processUserRequest };
