interface FormData { name: string; email: string; age: number }

function handleUserFormSubmit(data: FormData) {
  if (!data.name || data.name.length < 2) {
    throw new Error("Invalid name");
  }
  if (!data.email || !data.email.includes("@")) {
    throw new Error("Invalid email");
  }
  if (data.age < 0 || data.age > 150) {
    throw new Error("Invalid age");
  }
  return saveUser(data);
}

function handleAdminFormSubmit(data: FormData) {
  if (!data.name || data.name.length < 2) {
    throw new Error("Invalid name");
  }
  if (!data.email || !data.email.includes("@")) {
    throw new Error("Invalid email");
  }
  if (data.age < 0 || data.age > 150) {
    throw new Error("Invalid age");
  }
  return saveAdmin(data);
}

function handleData(items: unknown[]) {
  const result = processResult(items);
  return result;
}

function processResult(items: unknown[]) {
  return items.filter(Boolean);
}
