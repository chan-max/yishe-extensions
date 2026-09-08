import { computed, onMounted, onUnmounted, ref } from "vue";
import type { SiteModule } from "@/shared/site-adapter/types";
import { getMatchedSiteModule } from "@/shared/site-adapter/registry";

export interface ActiveTabState {
  id: number | null;
  url: string;
  hostname: string;
  title: string;
  favIconUrl: string;
  loading: boolean;
}

export function useActiveTab() {
  const currentTab = ref<ActiveTabState>({
    id: null,
    url: "",
    hostname: "",
    title: "",
    favIconUrl: "",
    loading: true,
  });

  const matchedModule = computed<SiteModule>(() => {
    return getMatchedSiteModule(currentTab.value.url);
  });

  async function updateActiveTab() {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab) return;

      let hostname = "";
      try {
        if (tab.url) {
          hostname = new URL(tab.url).hostname;
        }
      } catch (_) {}

      currentTab.value = {
        id: tab.id ?? null,
        url: tab.url || "",
        hostname: hostname || "未知站点",
        title: tab.title || "无标题页面",
        favIconUrl: tab.favIconUrl || "",
        loading: false,
      };
    } catch (_) {
      currentTab.value.loading = false;
    }
  }

  function handleTabActivated() {
    void updateActiveTab();
  }

  function handleTabUpdated(
    tabId: number,
    changeInfo: { status?: string; url?: string; title?: string },
  ) {
    if (
      currentTab.value.id === tabId &&
      (changeInfo.url || changeInfo.title || changeInfo.status === "complete")
    ) {
      void updateActiveTab();
    }
  }

  onMounted(() => {
    void updateActiveTab();
    if (typeof chrome !== "undefined" && chrome.tabs) {
      chrome.tabs.onActivated.addListener(handleTabActivated);
      chrome.tabs.onUpdated.addListener(handleTabUpdated);
    }
  });

  onUnmounted(() => {
    if (typeof chrome !== "undefined" && chrome.tabs) {
      chrome.tabs.onActivated.removeListener(handleTabActivated);
      chrome.tabs.onUpdated.removeListener(handleTabUpdated);
    }
  });

  return {
    currentTab,
    matchedModule,
    refreshTab: updateActiveTab,
  };
}
