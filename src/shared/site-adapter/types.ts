export interface SiteActionContext {
  tabId: number;
  url: string;
  hostname: string;
  title: string;
}

export interface SiteAction {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  badge?: string;
  primary?: boolean;
  handler: (context: SiteActionContext) => Promise<void> | void;
}

export interface SiteModule {
  id: string;
  name: string;
  icon?: string;
  description?: string;
  match: (url: URL) => boolean;
  actions: SiteAction[];
}
