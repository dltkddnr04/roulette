import { type KeyboardEvent, type ReactNode, useEffect, useState } from 'react';

export type SettingsTabDefinition = {
  id: string;
  label: string;
  content: ReactNode;
};

export type SettingsTabsProps = {
  tabs: readonly SettingsTabDefinition[];
  id?: string;
  defaultTabId?: string;
};

export function SettingsTabs({ tabs, id = 'settings-tabs', defaultTabId }: SettingsTabsProps) {
  const firstTabId = tabs[0]?.id ?? '';
  const [activeTabId, setActiveTabId] = useState(defaultTabId ?? firstTabId);
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTabId)) setActiveTabId(firstTabId);
  }, [activeTabId, firstTabId, tabs]);

  if (!activeTab) return null;

  const focusTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    setActiveTabId(tab.id);
    window.requestAnimationFrame(() => {
      document.getElementById(`${id}-tab-${tab.id}`)?.focus();
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (tabs.length < 2) return;
    const currentIndex = tabs.findIndex((tab) => tab.id === activeTabId);
    if (currentIndex < 0) return;

    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    focusTab(nextIndex);
  };

  const panelId = `${id}-panel-${activeTab.id}`;

  return (
    <div className="settings-tabs" id={id}>
      <div className="settings-tab-list" role="tablist" aria-label="Settings sections">
        {tabs.map((tab) => {
          const selected = tab.id === activeTab.id;
          return (
            <button
              key={tab.id}
              id={`${id}-tab-${tab.id}`}
              type="button"
              className={`settings-tab${selected ? ' active' : ''}`}
              role="tab"
              aria-selected={selected}
              aria-controls={`${id}-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setActiveTabId(tab.id)}
              onKeyDown={handleKeyDown}
            >
              <span data-trans>{tab.label}</span>
            </button>
          );
        })}
      </div>
      <div className="settings-tab-panel" id={panelId} role="tabpanel" aria-labelledby={`${id}-tab-${activeTab.id}`}>
        {activeTab.content}
      </div>
    </div>
  );
}
