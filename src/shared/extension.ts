const extensionApi = chrome;

export function getExtensionUrl(path: string) {
  return extensionApi.runtime.getURL(path.replace(/^\/+/, ""));
}

export function navigateToExtensionPage(path: string) {
  window.location.href = getExtensionUrl(path);
}

export async function openExtensionTab(path: string) {
  await new Promise<void>((resolve, reject) => {
    extensionApi.tabs.create({ url: getExtensionUrl(path) }, () => {
      if (extensionApi.runtime.lastError) {
        reject(new Error(extensionApi.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

export function closeCurrentWindow() {
  try {
    window.close();
  } catch {
    // noop
  }
}

export async function storageGet<T = Record<string, unknown>>(
  keys: string | string[] | Record<string, unknown>,
) {
  return await new Promise<T>((resolve) => {
    extensionApi.storage.local.get(keys, (result) => {
      resolve((result || {}) as T);
    });
  });
}

export async function storageSet(values: Record<string, unknown>) {
  await new Promise<void>((resolve, reject) => {
    extensionApi.storage.local.set(values, () => {
      if (extensionApi.runtime.lastError) {
        reject(new Error(extensionApi.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

export async function storageRemove(keys: string | string[]) {
  await new Promise<void>((resolve, reject) => {
    extensionApi.storage.local.remove(keys, () => {
      if (extensionApi.runtime.lastError) {
        reject(new Error(extensionApi.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

export async function sendRuntimeMessage<T = unknown>(message: unknown) {
  return await new Promise<T>((resolve, reject) => {
    extensionApi.runtime.sendMessage(message, (response) => {
      if (extensionApi.runtime.lastError) {
        reject(new Error(extensionApi.runtime.lastError.message));
      } else {
        resolve(response as T);
      }
    });
  });
}

export function addRuntimeMessageListener(
  listener: (message: unknown, sender: chrome.runtime.MessageSender) => void,
) {
  const wrapped: Parameters<typeof chrome.runtime.onMessage.addListener>[0] = (
    message,
    sender,
  ) => {
    listener(message, sender);
    return false;
  };

  extensionApi.runtime.onMessage.addListener(wrapped);
  return () => extensionApi.runtime.onMessage.removeListener(wrapped);
}

export function addStorageListener(
  listener: (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => void,
) {
  extensionApi.storage.onChanged.addListener(listener);
  return () => extensionApi.storage.onChanged.removeListener(listener);
}
