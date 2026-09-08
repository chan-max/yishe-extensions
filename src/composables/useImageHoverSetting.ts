import { onMounted, onUnmounted, ref } from "vue";
import { storageGet, storageSet } from "@/shared/extension";

export const STORAGE_KEY_IMAGE_HOVER = "imageHoverEnabled";

export function useImageHoverSetting() {
  const loading = ref(true);
  const imageHoverEnabled = ref(true);

  async function broadcastToTabs(enabled: boolean) {
    if (typeof chrome === "undefined" || !chrome.tabs?.query) {
      return;
    }
    try {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.id) {
          chrome.tabs
            .sendMessage(tab.id, {
              action: "yishe:set-image-hover-enabled",
              enabled,
            })
            .catch(() => {
              // 忽略不支持或未注入 content script 的系统标签页错误
            });
        }
      }
    } catch (_) {}
  }

  async function refresh() {
    loading.value = true;
    try {
      const data = await storageGet<Record<string, unknown>>(
        STORAGE_KEY_IMAGE_HOVER,
      );
      imageHoverEnabled.value = data[STORAGE_KEY_IMAGE_HOVER] !== false;
    } catch (_) {
      imageHoverEnabled.value = true;
    } finally {
      loading.value = false;
    }
  }

  async function setEnabled(nextValue: boolean) {
    imageHoverEnabled.value = nextValue;
    try {
      await storageSet({ [STORAGE_KEY_IMAGE_HOVER]: nextValue });
    } catch (_) {}
    void broadcastToTabs(nextValue);
  }

  async function toggle() {
    await setEnabled(!imageHoverEnabled.value);
  }

  function handleStorageChange(
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) {
    if (areaName === "local" && STORAGE_KEY_IMAGE_HOVER in changes) {
      const newVal = changes[STORAGE_KEY_IMAGE_HOVER].newValue;
      imageHoverEnabled.value = newVal !== false;
    }
  }

  onMounted(() => {
    void refresh();
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.addListener(handleStorageChange);
    }
  });

  onUnmounted(() => {
    if (typeof chrome !== "undefined" && chrome.storage?.onChanged) {
      chrome.storage.onChanged.removeListener(handleStorageChange);
    }
  });

  return {
    loading,
    imageHoverEnabled,
    refresh,
    setEnabled,
    toggle,
  };
}
